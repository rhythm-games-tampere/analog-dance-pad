#include "Adp.h"
#include <cctype>
#include <chrono>
#include <cstdio>
#include <string>
#include <system_error>
#include <ixwebsocket/IXWebSocketServer.h>
#include "WebsocketServer.h"
#include "MSGQ.hpp"
#include "Model/Players.h"

namespace adp
{
// Past this much unsent data a client is closed with 4008 "Too slow" (memory
// bound). Snapshots don't pile up (a newer one replaces an unsent one), so
// only a client that stopped reading gets here.
constexpr size_t MAX_QUEUED_BYTES = 64 * 1024 * 1024;

// A send that can't finish in this long closes the client. A client that
// stopped reading (an asleep phone with the socket still open) never fails a
// send otherwise. Long enough for a 4MB avatar on a slow phone.
constexpr int SEND_TIMEOUT_SECS = 30;

void WebsocketServer::Enqueue(Outbox& outbox, const Text& text, const std::string& pad)
{
	{
		std::lock_guard<std::mutex> lock(outbox.mutex);
		if (outbox.closed || outbox.tooSlow)
			return;
		// Only among the trailing snapshots: one may not overtake an earlier
		// message (a snapshot never comes before the pad list that names its pad).
		if (!pad.empty())
			for (auto it = outbox.entries.rbegin(); it != outbox.entries.rend() && !it->pad.empty(); ++it)
				if (it->pad == pad)
				{
					outbox.bytes = outbox.bytes - it->text->size() + text->size();
					it->text = text;
					return;
				}
		if (outbox.bytes + text->size() > MAX_QUEUED_BYTES)
		{
			outbox.tooSlow = true;
			outbox.entries.clear();
		}
		else
		{
			outbox.bytes += text->size();
			outbox.entries.push_back({pad, text});
		}
	}
	outbox.cv.notify_one();
}

void WebsocketServer::RunSender(std::shared_ptr<ix::WebSocket> socket, std::shared_ptr<Outbox> outbox)
{
	bool open = true;
	while (open)
	{
		std::deque<Outbox::Entry> batch;
		{
			std::unique_lock<std::mutex> lock(outbox->mutex);
			outbox->cv.wait(lock, [&] { return outbox->closed || outbox->tooSlow || !outbox->entries.empty(); });
			if (outbox->closed)
				break;
			if (outbox->tooSlow)
			{
				lock.unlock();
				std::printf("Client too slow (over %zu bytes unsent), disconnecting\n", MAX_QUEUED_BYTES);
				socket->close(4008, "Too slow");
				break;
			}
			batch.swap(outbox->entries);
		}
		// Not under the outbox lock: a failing send closes the socket, and ix
		// runs our Close handler (which takes it) on this thread.
		for (auto& entry : batch)
		{
			open = socket->send(*entry.text).success;
			std::lock_guard<std::mutex> lock(outbox->mutex);
			outbox->bytes -= entry.text->size();
			// Closed or too slow: the rest of the batch waits for nothing.
			if (!open || outbox->closed || outbox->tooSlow)
				break;
		}
	}
	{
		// A send can fail before the Close handler retires this client: stop
		// queueing for it meanwhile.
		std::lock_guard<std::mutex> lock(outbox->mutex);
		outbox->closed = true;
		outbox->entries.clear();
	}
	outbox->done = true;
}

void WebsocketServer::Retire(std::map<const ix::WebSocket*, Client>::iterator it)
{
	{
		std::lock_guard<std::mutex> lock(it->second.outbox->mutex);
		it->second.outbox->closed = true;
	}
	it->second.outbox->cv.notify_one();
	retired.emplace_back(it->second.outbox, std::move(it->second.sender));
	clients.erase(it);
}

void WebsocketServer::JoinRetired(bool all)
{
	std::vector<std::thread> finished;
	{
		std::lock_guard<std::mutex> lock(clientsMutex);
		// done is set just before the sender returns, so joining it is immediate.
		std::erase_if(retired, [&](auto& r) {
			if (!all && !r.first->done)
				return false;
			finished.push_back(std::move(r.second));
			return true;
		});
	}
	for (auto& t : finished)
		if (t.joinable())
			t.join();
}

void WebsocketServer::Deliver(const ix::WebSocket& socket, std::string message)
{
	std::lock_guard<std::mutex> lock(clientsMutex);
	if (auto it = clients.find(&socket); it != clients.end())
		Enqueue(*it->second.outbox, std::make_shared<const std::string>(std::move(message)));
}

void WebsocketServer::Broadcast(const Text& text)
{
	std::lock_guard<std::mutex> lock(clientsMutex);
	for (auto& [socket, client] : clients)
		Enqueue(*client.outbox, text);
}

// %XX and '+' decoded, as browsers encode query values.
static std::string PercentDecode(const std::string& s)
{
	std::string out;
	for (size_t i = 0; i < s.size(); ++i)
	{
		if (s[i] == '%' && i + 2 < s.size() && std::isxdigit((unsigned char)s[i + 1]) &&
		    std::isxdigit((unsigned char)s[i + 2]))
		{
			out.push_back((char)std::stoi(s.substr(i + 1, 2), nullptr, 16));
			i += 2;
		}
		else
			out.push_back(s[i] == '+' ? ' ' : s[i]);
	}
	return out;
}

// Compares in time independent of where the strings first differ.
static bool ConstantTimeEquals(const std::string& a, const std::string& b)
{
	if (a.size() != b.size())
		return false;
	unsigned char diff = 0;
	for (size_t i = 0; i < a.size(); ++i)
		diff |= (unsigned char)(a[i] ^ b[i]);
	return diff == 0;
}

bool AccessAllowed(const WebsocketAccess& access, const std::string& origin, const std::string& uri)
{
	if (!access.allowedOrigins.empty() && !access.allowedOrigins.contains(origin))
		return false;
	if (access.token.empty())
		return true;
	const auto q = uri.find('?');
	if (q == std::string::npos)
		return false;
	const std::string query = uri.substr(q + 1, uri.find('#', q) - q - 1);
	bool ok = false;
	for (size_t start = 0; start <= query.size();)
	{
		size_t end = query.find('&', start);
		if (end == std::string::npos)
			end = query.size();
		const std::string param = query.substr(start, end - start);
		if (param.rfind("token=", 0) == 0)
			ok |= ConstantTimeEquals(PercentDecode(param.substr(6)), access.token);
		start = end + 1;
	}
	return ok;
}

WebsocketServer::WebsocketServer() = default;

WebsocketServer::~WebsocketServer()
{
	// Normally empty by now (Init joins them after stopping the server).
	{
		std::lock_guard<std::mutex> lock(clientsMutex);
		while (!clients.empty())
			Retire(clients.begin());
	}
	JoinRetired(true);
}

void WebsocketServer::Init(MSGQ<QueueMessage>& queue, std::string host, WebsocketAccess access,
                           std::atomic<bool>& running, int port)
{
	auto srv = std::make_unique<ix::WebSocketServer>(
	    port, host, ix::SocketServer::kDefaultTcpBacklog, ix::SocketServer::kDefaultMaxConnections,
	    ix::WebSocketServer::kDefaultHandShakeTimeoutSecs, ix::SocketServer::kDefaultAddressFamily,
	    -1 /* no pings */, SEND_TIMEOUT_SECS);
	ix::WebSocketServer* ixServer = srv.get();

	srv->setOnClientMessageCallback([this, &queue, access, ixServer](
	                                    const std::shared_ptr<ix::ConnectionState>& connectionState,
	                                    ix::WebSocket& webSocket, const ix::WebSocketMessagePtr& msg) {
		if (msg->type == ix::WebSocketMessageType::Open)
		{
			const auto originIt = msg->openInfo.headers.find("Origin");
			const std::string origin = originIt == msg->openInfo.headers.end() ? "" : originIt->second;
			if (!AccessAllowed(access, origin, msg->openInfo.uri))
			{
				std::printf("Refused connection from %s (origin '%s')\n", connectionState->getRemoteIp().c_str(),
				            origin.c_str());
				webSocket.close(4003, "Forbidden");
				return;
			}
			std::printf("New connection from %s (id: %s)\n", connectionState->getRemoteIp().c_str(),
			            connectionState->getId().c_str());

			JoinRetired(false);

			// The sender keeps the socket alive until it returns.
			std::shared_ptr<ix::WebSocket> socket;
			for (const auto& s : ixServer->getClients())
				if (s.get() == &webSocket)
					socket = s;
			if (!socket)
			{
				webSocket.close(1011, "Internal error");
				return;
			}

			auto outbox = std::make_shared<Outbox>();
			Enqueue(*outbox, std::make_shared<const std::string>(
			                     nlohmann::json{{"msgType", 0}, {"protocol", PROTOCOL_VERSION}, {"server", ADP_VERSION_STR}}
			                         .dump()));

			// Queue the current device list, pad states, players and lights so
			// the client doesn't wait for the next change to see them, then admit
			// it. Admitting last keeps snapshots from arriving before the pad
			// list; replayMutex keeps any Publish() from slipping in between.
			bool admitted = false;
			{
				std::lock_guard<std::mutex> lock(replayMutex);
				for (const auto& [key, messages] : replay)
					for (const auto& m : messages)
						Enqueue(*outbox, m);
				// The sender is started and listed under one clientsMutex hold: if
				// its first send fails, the Close handler it runs waits for the
				// listing and then retires it, instead of missing it and leaving a
				// dead client listed.
				std::lock_guard<std::mutex> clientsLock(clientsMutex);
				if (auto it = clients.find(&webSocket); it != clients.end())
					Retire(it);
				try
				{
					clients[&webSocket] = {connectionState->getId(), "*", outbox,
					                       std::thread(&WebsocketServer::RunSender, std::move(socket), outbox)};
					admitted = true;
				}
				catch (const std::system_error& e)
				{
					clients.erase(&webSocket);
					std::printf("Client %s refused, no sender thread (%s)\n", connectionState->getId().c_str(),
					            e.what());
				}
			}
			if (!admitted)
			{
				webSocket.close(1011, "Internal error");
				return;
			}
			snapshotResend = true;
		}
		else if (msg->type == ix::WebSocketMessageType::Close)
		{
			std::printf("Client %s WebSocket disconnected, reason: %s\n", connectionState->getId().c_str(),
			            msg->closeInfo.reason.c_str());
			// May run on the client's own sender thread (a failed send), so it
			// is only retired here, and joined later.
			{
				std::lock_guard<std::mutex> lock(clientsMutex);
				if (auto it = clients.find(&webSocket); it != clients.end())
					Retire(it);
			}
			// Senders that already returned (never this one: it is still running).
			JoinRetired(false);
		}
		else if (msg->type == ix::WebSocketMessageType::Message)
		{
			{
				std::lock_guard<std::mutex> lock(clientsMutex);
				if (!clients.contains(&webSocket))
					return; // refused, still closing
			}
			// Avatars are file-only and can be MBs, so answer them here, to the
			// asking client only, instead of on the device thread. The name is
			// looked up in the scanned player list, never used as a path.
			// Subscriptions are per connection, so they are handled here too.
			if (msg->str.find("\"getAvatar\"") != std::string::npos ||
			    msg->str.find("\"subscribe\"") != std::string::npos)
			{
				const auto j = nlohmann::json::parse(msg->str, nullptr, false);
				if (j.is_object() && j.contains("getAvatar") && j["getAvatar"].is_string())
				{
					Deliver(webSocket, Players::AvatarMessage(j["getAvatar"].get<std::string>()));
					return;
				}
				if (j.is_object() && j.contains("subscribe") && j["subscribe"].is_string())
				{
					{
						std::lock_guard<std::mutex> lock(clientsMutex);
						if (auto it = clients.find(&webSocket); it != clients.end())
							it->second.subscription = j["subscribe"].get<std::string>();
					}
					snapshotResend = true;
					return;
				}
			}
			// Enqueue the message by value; the device thread drains and applies it.
			queue.push(QueueMessage(msg->str, connectionState->getId()));
		}
	});

	if (auto [success, error] = srv->listen(); !success)
	{
		// Exit instead of running headless, so a supervisor (systemd) restarts us.
		std::printf("ERROR: cannot listen on %s:%d: %s\n", host.c_str(), port, error.c_str());
		failed = true;
		running = false;
		return;
	}

	// Per message deflate connection is enabled by default. It can be disabled
	// which might be helpful when running on low power devices such as a Raspberry Pi
	srv->disablePerMessageDeflate();

	// Run the server in the background. Server can be stopped by calling Stop().
	srv->start();
	std::printf("Websocket server started on ws://%s:%d%s\n", host.c_str(), port,
	            access.token.empty() ? "" : " (token required)");

	// Publish the owned server so Stop() can reach it, then block until Stop().
	// Our own condition (not ix's wait(), which misses a stop that came first)
	// also covers a Stop() issued before we got here.
	std::unique_lock<std::mutex> lock(serverMutex);
	server = std::move(srv);
	stopCv.wait(lock, [this] { return stopRequested; });
	ix::WebSocketServer* s = server.get();
	lock.unlock();

	// Outside the lock: stop() joins the connection threads.
	s->stop();
	{
		std::lock_guard<std::mutex> clientsLock(clientsMutex);
		while (!clients.empty())
			Retire(clients.begin());
	}
	JoinRetired(true);
}

void WebsocketServer::SendMessageToClients(const std::string& message)
{
	Broadcast(std::make_shared<const std::string>(message));
}

void WebsocketServer::SendTo(const std::string& clientId, const std::string& message)
{
	std::lock_guard<std::mutex> lock(clientsMutex);
	for (auto& [socket, client] : clients)
		if (client.id == clientId)
		{
			Enqueue(*client.outbox, std::make_shared<const std::string>(message));
			return;
		}
}

bool WebsocketServer::TakeSnapshotResend()
{
	return snapshotResend.exchange(false);
}

bool WebsocketServer::HasClients()
{
	std::lock_guard<std::mutex> lock(clientsMutex);
	return !clients.empty();
}

void WebsocketServer::Publish(const std::string& key, std::vector<std::string> messages)
{
	std::vector<Text> texts;
	texts.reserve(messages.size());
	for (auto& m : messages)
		texts.push_back(std::make_shared<const std::string>(std::move(m)));
	std::lock_guard<std::mutex> lock(replayMutex);
	for (const auto& t : texts)
		Broadcast(t);
	replay[key] = std::move(texts);
}

void WebsocketServer::SendSnapshot(const std::string& pad, const std::string& message)
{
	const auto text = std::make_shared<const std::string>(message);
	std::lock_guard<std::mutex> lock(clientsMutex);
	for (auto& [socket, client] : clients)
		if (client.subscription == "*" || client.subscription == pad)
			Enqueue(*client.outbox, text, pad);
}

void WebsocketServer::Stop()
{
	{
		std::lock_guard<std::mutex> lock(serverMutex);
		stopRequested = true;
	}
	stopCv.notify_all();
}
} // namespace adp
