<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pads, SCREENS, type Screen } from '$lib/pads.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	interface Props {
		actions?: Snippet; // right-aligned in the header
		children: Snippet;
	}

	let { actions, children }: Props = $props();

	const step = $derived(pads.step);
	const snap = $derived(pads.activeSnapshot);
	const loadedProfile = $derived(pads.loadedProfile);
	const reached = (s: Screen) => SCREENS.indexOf(step) > SCREENS.indexOf(s);
</script>

<div class="mx-auto flex h-[100dvh] max-w-5xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
	{#if step !== 'server'}
		<!-- breadcrumb: each chip links back to its screen -->
		<header class="flex flex-wrap items-center gap-2">
			<Button variant="outline" href={pads.href('server')}>
				{pads.serverName}
				<ChevronDownIcon />
			</Button>
			{#if reached('pad')}
				<Button variant="outline" href={pads.href('pad')}>{pads.padName}</Button>
			{/if}
			{#if reached('player') && pads.player}
				<Button variant="outline" href={pads.href('player')}>{pads.player}</Button>
			{/if}
			{#if reached('profile') && pads.player}
				<Button variant="outline" href={pads.href('profile')}>
					{loadedProfile?.name ?? 'No profile'}
				</Button>
				{#if pads.loadingProfile}
					<Badge variant="outline">loading profile…</Badge>
				{:else if snap?.saveFailed}
					<Badge variant="destructive" title="The server keeps retrying every 2 seconds"
						>not saved to the pad</Badge
					>
				{:else if snap?.unsaved}
					<Badge variant="outline" title="Edits reach the pad's memory ~2s after the last one"
						>saving…</Badge
					>
				{:else if pads.padState?.editsLost}
					<Badge
						variant="destructive"
						title="The pad was unplugged before its last edits were saved: check its settings, or load a profile"
						>last edits lost</Badge
					>
				{/if}
			{/if}

			{#if actions}
				<div class="ml-auto flex items-center gap-2">{@render actions()}</div>
			{/if}
		</header>
	{/if}

	{#if step !== 'server' && pads.conn?.status === 'open' && !pads.localProfilesOk}
		<div class="rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-2 text-sm">
			Player list is offline (shared LocalProfiles folder not reachable): showing the last known
			players. Retrying automatically.
		</div>
	{/if}

	<!-- -mx-1 px-1: room for the cards' outside rings, which overflow-y-auto would clip -->
	<main class="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
		{@render children()}
	</main>
</div>
