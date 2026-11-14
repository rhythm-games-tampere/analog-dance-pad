<script lang="ts">
	import { pads } from '$lib/pads.svelte';

	// The polling rate, shown beside a tuning screen's header buttons.
	const snap = $derived(pads.activeSnapshot);
</script>

{#if snap}
	<span class="text-muted-foreground text-sm tabular-nums">{snap.pollingRate} Hz</span>
{/if}
