// The plugin owns profile 0, layer 1. On the Creator Micro 2 the Input app's
// "profile 2" and "profile 3" are layers 2 and 3 of the same profile, so the
// layer index (1-based in device.status) is what changes when the user
// switches. Bindings, lights and input handling are active only on layer 1.
export function isOwnedLayer(status: Record<string, unknown>): boolean {
  const profile = Number.isInteger(status.profile_index) ? (status.profile_index as number) : 0;
  const layer = Number.isInteger(status.layer_index) ? (status.layer_index as number) : 1;
  return profile === 0 && layer === 1;
}
