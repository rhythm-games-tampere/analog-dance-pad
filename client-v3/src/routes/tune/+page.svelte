<script lang="ts">
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { pads } from '$lib/pads.svelte';
	import Shell from '$lib/components/Shell.svelte';
	import ButtonBox from '$lib/components/ButtonBox.svelte';
	import CalibrationModal from '$lib/components/CalibrationModal.svelte';
	import TuneActions from '$lib/components/TuneActions.svelte';
	import { Button } from '$lib/components/ui/button';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ScaleIcon from '@lucide/svelte/icons/scale';

	const snap = $derived(pads.activeSnapshot);
	const groups = $derived(pads.buttonGroups);
</script>

<Shell>
	{#snippet actions()}
		<TuneActions />
		{#if snap}
			{#if groups.length > 0}
				<Button
					variant="outline"
					size="icon"
					aria-label="Calibrate sensors"
					onclick={() => pushState('', { calibrate: true })}
				>
					<ScaleIcon />
				</Button>
			{/if}
			<Button variant="outline" size="icon" aria-label="Configure" href={pads.href('config')}>
				<SettingsIcon />
			</Button>
		{/if}
	{/snippet}

	{#if !snap}
		<p class="text-muted-foreground">Waiting for pad data…</p>
	{:else if groups.length === 0}
		<p class="text-muted-foreground">This pad has no mapped sensors.</p>
	{:else}
		<div class="flex h-full min-h-0 w-full gap-2 py-2">
			{#each groups as g (g.button)}
				<div class="min-w-0" style="flex: {g.sensors.length} 1 0">
					<ButtonBox
						group={g}
						href={pads.href('arrow', { button: g.button })}
						releaseEnabled={pads.releaseEnabled}
						onthreshold={(i, v) => pads.setThreshold(i, v)}
						oncommit={() => pads.commit()}
					/>
				</div>
			{/each}
		</div>
	{/if}
</Shell>

{#if page.state.calibrate}
	<CalibrationModal
		onapply={(pct, rel) => pads.calibrateThresholds(pct, rel)}
		onclose={() => page.state.calibrate && history.back()}
	/>
{/if}
