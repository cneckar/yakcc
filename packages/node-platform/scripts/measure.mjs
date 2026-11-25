// SPDX-License-Identifier: Apache-2.0
// Shave every module of the vendored library through the real pipeline and report, per module, what
// the gate says (#1331). Run after building: `node scripts/measure.mjs > report.txt`.
import { nodeModuleIds, shaveNodeModule } from "../dist/index.js";

let atoms = 0;
let clean = 0;
let cleanModules = 0;
const ids = nodeModuleIds();
for (const id of ids) {
  const r = await shaveNodeModule(id);
  atoms += r.atoms;
  clean += r.clean;
  const ok = r.clean === r.atoms;
  if (ok) cleanModules++;
  else
    console.log(
      `${id}: ${r.clean}/${r.atoms} clean; unexplained ${JSON.stringify(r.unexplained)}; unfaithful ${JSON.stringify(r.unfaithful)}; lift errors ${r.liftErrors.length}`,
    );
}
console.log(`modules ${ids.length}, clean modules ${cleanModules}; atoms ${atoms}, clean ${clean}`);
