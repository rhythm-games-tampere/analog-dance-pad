<script lang="ts">
	import type { Sensor } from '$lib/pads.svelte';

	interface Props {
		sensor: Sensor;
		label: string; // the button's name, or "Button N"
		releaseEnabled: boolean; // false in "None" mode: hide the release marker
		onthreshold: (value: number) => void;
		oncommit: () => void; // an edit is complete (drag released, key nudge)
		onedit?: () => void; // makes the whole element (labels included) a button
	}

	let { sensor, label, releaseEnabled, onthreshold, oncommit, onedit }: Props = $props();

	let trackEl = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);

	const pct = (v: number) => Math.round(v * 100);

	// Pad-authoritative activation (honors release threshold / release mode).
	const active = $derived(sensor.pressed);
	const showRelease = $derived(releaseEnabled && sensor.releaseThreshold !== sensor.threshold);

	function valueFromPointer(clientY: number) {
		if (!trackEl) return sensor.threshold;
		const rect = trackEl.getBoundingClientRect();
		return Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
	}

	function onPointerDown(e: PointerEvent) {
		e.stopPropagation();
		dragging = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		onthreshold(valueFromPointer(e.clientY));
	}
	function onPointerMove(e: PointerEvent) {
		if (dragging) onthreshold(valueFromPointer(e.clientY));
	}
	// Arrow keys nudge by 1%, Page Up/Down by 10%, Home/End to the ends.
	function onKeyDown(e: KeyboardEvent) {
		const step: Record<string, number> = {
			ArrowUp: 0.01,
			ArrowRight: 0.01,
			ArrowDown: -0.01,
			ArrowLeft: -0.01,
			PageUp: 0.1,
			PageDown: -0.1,
			Home: -1,
			End: 1
		};
		if (!(e.key in step)) return;
		e.preventDefault();
		e.stopPropagation(); // Space/Enter open the editor; arrows don't
		onthreshold(Math.min(1, Math.max(0, sensor.threshold + step[e.key])));
		oncommit();
	}
	function onPointerUp(e: PointerEvent) {
		if (dragging) oncommit();
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
	}
</script>

{#snippet content()}
	<span class="text-muted-foreground text-sm leading-none tabular-nums">
		{sensor.disabled ? 'off' : `${pct(sensor.value)}%`}
	</span>

	<div
		bind:this={trackEl}
		class="bg-muted relative min-h-0 w-full flex-1 overflow-hidden rounded-md {sensor.disabled
			? 'opacity-40'
			: ''}"
		title={sensor.disabled ? "The pad doesn't read this sensor" : undefined}
	>
		<!-- value fill -->
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 transition-[height] duration-75 ease-out {active
				? 'bg-primary shadow-[0_0_18px_2px_var(--color-primary)]'
				: 'bg-secondary-foreground/25'}"
			style="height: {pct(sensor.value)}%"
		></div>

		<!-- release-threshold marker (read-only; edited only in the editor) -->
		{#if showRelease}
			<div
				class="pointer-events-none absolute inset-x-0 h-0.5 bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400)]"
				style="bottom: calc({pct(sensor.releaseThreshold)}% - 1px)"
				title="Release threshold"
			></div>
		{/if}

		<!-- visible threshold line -->
		<div
			class="bg-primary-foreground pointer-events-none absolute inset-x-0 h-0.5 shadow-[0_0_6px_var(--color-primary)]"
			style="bottom: calc({pct(sensor.threshold)}% - 1px)"
		></div>

		<!-- oversized drag handle (touch-friendly), centered on the line -->
		<div
			class="absolute inset-x-0 h-11 cursor-row-resize touch-none"
			style="bottom: calc({pct(sensor.threshold)}% - 22px)"
			onclick={(e) => {
				// a drag ends in a click: it must not open the editor or follow the box's link
				e.preventDefault();
				e.stopPropagation();
			}}
			onkeydown={onKeyDown}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			role="slider"
			aria-label="Threshold for {label}"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={pct(sensor.threshold)}
			tabindex="0"
		></div>
	</div>

	<span class="text-primary text-sm leading-none font-medium tabular-nums">
		{pct(sensor.threshold)}%
	</span>
{/snippet}

{#if onedit}
	<div
		class="flex h-full cursor-pointer flex-col items-center gap-1 px-0.5 select-none sm:px-1"
		onclick={onedit}
		role="button"
		tabindex="0"
		aria-label="Edit {label}"
		onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onedit()}
	>
		{@render content()}
	</div>
{:else}
	<div class="flex h-full flex-col items-center gap-1 px-0.5 select-none sm:px-1">
		{@render content()}
	</div>
{/if}
