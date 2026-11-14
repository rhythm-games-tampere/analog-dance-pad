// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		/** Open modals are shallow history entries, so Back closes them. */
		interface PageState {
			sensor?: number; // snapshot index of the sensor being edited
			calibrate?: boolean;
		}
		// interface Platform {}
	}
}

export {};
