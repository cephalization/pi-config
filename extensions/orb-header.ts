import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const ORB_ANGLE = 0.65;
const TILT = -0.28;

class OrbHeader implements Component {
	constructor(private readonly theme: Theme) {}

	render(width: number): string[] {
		if (width < 32) return [];

		const height = width >= 100 ? 15 : width >= 60 ? 11 : 7;
		const orbWidth = width >= 100 ? 34 : width >= 60 ? 24 : 16;
		const canvas = Array.from({ length: height }, () => Array<string>(orbWidth).fill(" "));
		const depth = Array.from({ length: height }, () => Array<number>(orbWidth).fill(-Infinity));
		const cosA = Math.cos(ORB_ANGLE);
		const sinA = Math.sin(ORB_ANGLE);
		const cosTilt = Math.cos(TILT);
		const sinTilt = Math.sin(TILT);
		const radiusX = (orbWidth - 2) / 2;
		const radiusY = (height - 2) / 2;

		for (let latitude = 1; latitude < 22; latitude++) {
			const theta = (latitude / 22) * Math.PI;
			const sinTheta = Math.sin(theta);
			const y = Math.cos(theta);

			for (let longitude = 0; longitude < 52; longitude++) {
				// Offset alternating rings to keep the point cloud organic rather than gridded.
				const phi = (longitude / 52) * Math.PI * 2 + (latitude % 2) * 0.045;
				const x = sinTheta * Math.cos(phi);
				const z = sinTheta * Math.sin(phi);

				const rotatedX = x * cosA + z * sinA;
				const rotatedZ = -x * sinA + z * cosA;
				const rotatedY = y * cosTilt - rotatedZ * sinTilt;
				const finalZ = y * sinTilt + rotatedZ * cosTilt;
				const column = Math.round(radiusX + rotatedX * radiusX);
				const row = Math.round(radiusY + rotatedY * radiusY);

				if (row < 0 || row >= height || column < 0 || column >= orbWidth) continue;
				if (finalZ <= depth[row]![column]!) continue;

				depth[row]![column] = finalZ;
				const shimmer = Math.sin(phi * 3 + ORB_ANGLE * 1.7) * 0.13;
				const light = finalZ * 0.7 - rotatedX * 0.25 - rotatedY * 0.15 + shimmer;
				canvas[row]![column] = light > 0.55 ? "*" : light > 0.15 ? "+" : light > -0.3 ? ":" : ".";
			}
		}

		const leftPadding = Math.max(0, width - orbWidth - Math.max(2, Math.floor(width * 0.05)));
		return [
			"",
			...canvas.map((row) => " ".repeat(leftPadding) + this.theme.fg("dim", row.join(""))),
			"",
		];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const apply = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(enabled ? (_tui, theme) => new OrbHeader(theme) : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		apply(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
	});

	pi.registerCommand("orb", {
		description: "Toggle the animated orb header",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(`Orb ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
