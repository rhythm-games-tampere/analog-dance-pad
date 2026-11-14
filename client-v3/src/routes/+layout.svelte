<script lang="ts">
	import './layout.css';
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { pads, screenOf } from '$lib/pads.svelte';
	import { Button } from '$lib/components/ui/button';

	let { children } = $props();

	// Own the connection lifecycle here so it survives navigation between routes;
	// the pages just read the shared `pads` singleton.
	onMount(() => {
		pads.start();
		const server = pads.rememberedServer;
		if (page.route.id === '/' && server) goto(pads.href('pad', { server }), { replaceState: true });
		return () => pads.stop();
	});

	$effect(() => {
		const screen = screenOf(page.route.id);
		const query = page.url.searchParams;
		untrack(() => pads.sync(screen, query));
	});

	afterNavigate((nav) => {
		pads.autoLoad =
			nav.type === 'link' && nav.from?.route.id === '/player' && nav.to?.route.id === '/profile';
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{#if pads.protocolError}
	<div role="alert" class="bg-destructive text-white px-4 py-2 text-center text-sm">
		{pads.protocolError}
	</div>
{/if}
{@render children()}

{#if pads.notice}
	{@const notice = pads.notice}
	<div
		role="status"
		class="bg-card fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full px-5 py-3 shadow-lg ring-1 {notice.ok
			? 'ring-foreground/10'
			: 'ring-destructive text-destructive'}"
	>
		<span>{notice.text}</span>
		{#if notice.ok && notice.op === 'loadProfile'}
			<Button
				variant="link"
				size="sm"
				href={pads.href('profile')}
				onclick={() => (pads.notice = null)}>Change</Button
			>
		{/if}
	</div>
{/if}
