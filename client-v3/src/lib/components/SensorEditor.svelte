<script lang="ts">
	import type { Sensor } from '$lib/pads.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		sensor: Sensor; // optimistic-overlaid values
		index: number; // snapshot sensor index
		label: string; // the button's name, or "Button N"
		releaseEnabled: boolean; // false in "None" mode: hide the release slider
		gainEnabled: boolean; // false unless the pad has a digipot (featureDigipot)
		onthreshold: (value: number) => void; // 0..1
		onrelease: (value: number) => void; // 0..1
		ongain: (byte: number) => void; // 0..255
		oncommit: () => void; // an edit is complete (slider released, button pressed, value entered)
		onclose: () => void;
	}

	let {
		sensor,
		index,
		label,
		releaseEnabled,
		gainEnabled,
		onthreshold,
		onrelease,
		ongain,
		oncommit,
		onclose
	}: Props = $props();

	// Gain in raw digipot steps, so every one of the 256 is reachable: higher =
	// more sensitivity = LOWER resistor byte (255 -> byte 0, 0 -> byte 255).
	const clampPct = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p);
	const gain = $derived(255 - sensor.resistorValue);
	const thresholdPct = $derived(Math.round(sensor.threshold * 100));
	const releasePct = $derived(Math.round(sensor.releaseThreshold * 100));

	let dialogEl = $state<HTMLDialogElement | null>(null);
	$effect(() => {
		dialogEl?.showModal();
	});

	const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
	const THUMB = 20; // px
	const livePct = $derived(sensor.disabled ? undefined : sensor.value * 100);
</script>

<dialog
	bind:this={dialogEl}
	{onclose}
	onclick={(e) => e.target === dialogEl && dialogEl?.close()}
	class="bg-card text-card-foreground m-auto w-[min(92vw,26rem)] rounded-lg border p-6 backdrop:bg-black/50"
>
	<div class="flex flex-col gap-5">
		<header class="flex items-center justify-between">
			<h2 class="text-lg font-semibold">
				Sensor {index} · {label}
			</h2>
			<Button variant="ghost" size="sm" onclick={() => dialogEl?.close()}>Done</Button>
		</header>

		{#snippet row(
			label: string,
			value: number,
			unit: string,
			commit: (v: number) => void,
			max: number,
			live?: number // the sensor's current value in the slider's units, drawn in the track
		)}
			<div class="flex flex-col gap-1">
				<span class="text-muted-foreground text-sm">{label}</span>
				<div class="flex items-center gap-3">
					<div class="relative h-6 flex-1">
						<div class="bg-muted absolute inset-x-0 top-2 h-2 overflow-hidden rounded-full">
							{#if live !== undefined}
								<!-- ends where the thumb's center would be at that value -->
								<div
									class="absolute inset-y-0 left-0 transition-[width] duration-75 ease-out {sensor.pressed
										? 'bg-primary'
										: 'bg-secondary-foreground/40'}"
									style="width: calc({THUMB / 2}px + (100% - {THUMB}px) * {max > 0
										? Math.min(1, Math.max(0, live / max))
										: 1})"
								></div>
							{/if}
						</div>
						<input
							type="range"
							min="0"
							{max}
							{value}
							oninput={(e) => commit(num(e))}
							onchange={oncommit}
							aria-label={label}
							class="slider absolute inset-0 h-6 w-full cursor-pointer"
							class:pressed={live !== undefined && sensor.pressed}
							style="--thumb: {THUMB}px"
						/>
					</div>
					<div class="flex items-center gap-1">
						<Input
							type="number"
							min={0}
							{max}
							{value}
							oninput={(e) => commit(num(e))}
							onchange={oncommit}
							aria-label="{label} value"
							class="w-16 text-right tabular-nums"
						/>
						<span class="text-muted-foreground w-3 text-sm">{unit}</span>
					</div>
				</div>
				<div class="flex gap-1">
					<Button
						variant="outline"
						size="icon-sm"
						class="w-16"
						onclick={() => {
							commit(value - 1);
							oncommit();
						}}
						aria-label="Decrease {label}"
					>
						−
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						class="w-16"
						onclick={() => {
							commit(value + 1);
							oncommit();
						}}
						aria-label="Increase {label}"
					>
						+
					</Button>
				</div>
			</div>
		{/snippet}

		{#if gainEnabled}
			{@render row('Gain', gain, '', (g) => ongain(255 - g), 255)}
		{/if}
		{@render row(
			'Threshold',
			thresholdPct,
			'%',
			(p) => onthreshold(clampPct(p) / 100),
			100,
			livePct
		)}
		{#if releaseEnabled}
			<!-- Release can never exceed the threshold, or hysteresis breaks; cap it. -->
			{@render row(
				'Release threshold',
				releasePct,
				'%',
				(p) => onrelease(Math.min(clampPct(p), thresholdPct) / 100),
				thresholdPct,
				livePct
			)}
		{/if}
	</div>
</dialog>

<style>
	.slider {
		appearance: none;
		background: transparent;
	}
	.slider::-webkit-slider-runnable-track {
		background: transparent;
	}
	.slider::-moz-range-track {
		background: transparent;
	}
	.slider::-webkit-slider-thumb {
		appearance: none;
		width: var(--thumb);
		height: var(--thumb);
		border: 0;
		border-radius: 9999px;
		background: var(--color-foreground);
		transition: background-color 75ms;
	}
	.slider::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		border: 0;
		border-radius: 9999px;
		background: var(--color-foreground);
		transition: background-color 75ms;
	}
	.slider.pressed::-webkit-slider-thumb {
		background: var(--color-primary);
		box-shadow: 0 0 10px 1px var(--color-primary);
	}
	.slider.pressed::-moz-range-thumb {
		background: var(--color-primary);
		box-shadow: 0 0 10px 1px var(--color-primary);
	}
</style>
