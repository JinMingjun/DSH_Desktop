/**
 * dsh-tray host half.
 *
 * Native tray behavior lives in DSH_Desktop.exe. Keeping a real host entry makes
 * this package participate in DSH's normal plugin inventory and enable/disable
 * lifecycle; the browser half forwards that lifecycle to the desktop host.
 */
export const name = "dsh-tray";

export function apply() {}
