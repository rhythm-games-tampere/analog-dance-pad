<script lang="ts">
	import { pads, type ButtonGroup } from '$lib/pads.svelte';
	import SensorBar from './SensorBar.svelte';

	interface Props {
		group: ButtonGroup;
		releaseEnabled: boolean;
		href?: string; // makes the whole box a link
		onthreshold: (index: number, value: number) => void;
		oncommit: () => void; // an edit is complete (drag released)
		onedit?: (index: number) => void; // makes each sensor (bar and labels) a button
	}

	let { group, releaseEnabled, href, onthreshold, oncommit, onedit }: Props = $props();

	// The button is active when any of its sensors is pressed (pad-authoritative).
	const active = $derived(group.sensors.some((m) => m.sensor.pressed));
	const name = $derived(pads.buttonName(group.button));
</script>

<svelte:element
	this={href ? 'a' : 'div'}
	{href}
	draggable={href ? 'false' : undefined}
	aria-label={href ? `Adjust ${pads.buttonLabel(group.button)}` : undefined}
	class="bg-card flex h-full min-h-0 flex-col gap-2 rounded-xl py-2 ring-1 transition-shadow {active
		? 'ring-primary shadow-[0_0_18px_2px_var(--color-primary)]'
		: 'ring-foreground/10'}"
>
	<span
		class="text-secondary-foreground shrink-0 truncate px-2 text-center text-sm leading-none font-semibold tabular-nums"
		title={name}
	>
		{name ?? group.button}
	</span>

	<!-- the sensors' own padding is the gap between them, so no tap falls in between -->
	<div class="grid min-h-0 flex-1 grid-flow-col auto-cols-fr px-1 sm:px-1.5">
		{#each group.sensors as m (m.index)}
			<SensorBar
				sensor={m.sensor}
				label={pads.buttonLabel(group.button)}
				{releaseEnabled}
				onthreshold={(v) => onthreshold(m.index, v)}
				{oncommit}
				onedit={onedit && (() => onedit(m.index))}
			/>
		{/each}
	</div>
</svelte:element>
