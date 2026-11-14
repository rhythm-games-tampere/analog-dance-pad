<script lang="ts">
	import { pads } from '$lib/pads.svelte';
	import Shell from '$lib/components/Shell.svelte';
	import PadCard from '$lib/components/PadCard.svelte';
</script>

<Shell>
	<h1 class="mb-4 text-2xl font-bold">Pick your pad</h1>
	{#if pads.conn?.status !== 'open'}
		<p class="text-muted-foreground">Connecting to {pads.serverName}…</p>
	{:else if pads.devices.length === 0}
		<p class="text-muted-foreground">No pads connected to {pads.serverName}.</p>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2">
			{#each pads.devices as d (d.id)}
				<PadCard device={d} />
			{/each}
		</div>
	{/if}
</Shell>
