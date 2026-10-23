#!/usr/bin/env bash
set -uo pipefail

echo '=== JUDGE: fixed regressions and unmount ==='
pnpm --dir apps/web exec vitest run --config vitest.config.ts src/call-states/menu-regressions.test.ts -t '^(?!judge: keeps the active)' --maxWorkers 1
fixed_status=$?

echo '=== JUDGE: active-camera divergence reproduction (expected failure) ==='
pnpm --dir apps/web exec vitest run --config vitest.config.ts src/call-states/menu-regressions.test.ts -t 'judge: keeps the active' --maxWorkers 1
divergence_status=$?

echo '=== JUDGE: original source mutation in disposable remote checkout ==='
git restore --source=origin/master -- sdks/typescript/react/src/components/device-popover/DevicePopover.tsx sdks/typescript/react/src/components/space-header/CallDetails.tsx sdks/typescript/react/src/components/space-header/SpaceHeader.tsx sdks/typescript/react/src/components/chalk/Chalk.tsx sdks/typescript/react/src/components/chalk-ui/ChalkMenu.tsx
pnpm --dir apps/web exec vitest run --config vitest.config.ts src/call-states/menu-regressions.test.ts -t '^(previews and switches|keeps shortcuts content)' --maxWorkers 1
baseline_status=$?

echo "JUDGE_RESULTS fixed=$fixed_status divergence=$divergence_status baseline=$baseline_status"
[[ $fixed_status == 0 && $divergence_status == 1 && $baseline_status == 1 ]]
