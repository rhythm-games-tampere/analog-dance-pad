<script lang="ts">
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { pads } from '$lib/pads.svelte';
	import Shell from '$lib/components/Shell.svelte';
	import ButtonBox from '$lib/components/ButtonBox.svelte';
	import SensorEditor from '$lib/components/SensorEditor.svelte';
	import TuneActions from '$lib/components/TuneActions.svelte';
	import { Button } from '$lib/components/ui/button';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';

	const snap = $derived(pads.activeSnapshot);
	const group = $derived(pads.buttonGroups.find((g) => g.button === pads.button));
	const editing = $derived(group?.sensors.find((m) => m.index === page.state.sensor));
</script>

<Shell>
	{#snippet actions()}
		<TuneActions />
		<Button variant="outline" href={pads.href('tune')}>
			<ChevronLeftIcon />
			All arrows
		</Button>
	{/snippet}

	{#if !snap}
		<p class="text-muted-foreground">Waiting for pad data…</p>
	{:else if !group}
		<p class="text-muted-foreground">This pad has no sensors on that arrow.</p>
	{:else}
		<div class="h-full min-h-0 w-full py-2">
			<ButtonBox
				{group}
				releaseEnabled={pads.releaseEnabled}
				onthreshold={(i, v) => pads.setThreshold(i, v)}
				oncommit={() => pads.commit()}
				onedit={(i) => pushState('', { sensor: i })}
			/>
		</div>
	{/if}
</Shell>

{#if editing}
	<SensorEditor
		sensor={editing.sensor}
		index={editing.index}
		label={pads.buttonLabel(editing.sensor.button)}
		releaseEnabled={pads.releaseEnabled}
		gainEnabled={pads.device?.featureDigipot ?? false}
		onthreshold={(v) => pads.setThreshold(editing.index, v)}
		onrelease={(v) => pads.setReleaseThreshold(editing.index, v)}
		ongain={(b) => pads.setGain(editing.index, b)}
		oncommit={() => pads.commit()}
		onclose={() => page.state.sensor !== undefined && history.back()}
	/>
{/if}
