"""Instrument only a disposable capture copy, never the lane checkout."""
from pathlib import Path
import shutil
import sys

app = Path(sys.argv[1]).resolve()
source = app / 'src'
sdk = app.parents[1] / 'sdks/typescript/react-native/src/frame/dev-scenario.ts'
supports_call_state = 'readonly callState?' in sdk.read_text()
(source / 'dev-states/sdk-capabilities.ts').write_text('export const supportsCallState = ' + str(supports_call_state).lower() + ';\n')
if not (source / 'home/HomeScreen.tsx').exists():
    raise SystemExit(0)
shutil.copyfile(Path(__file__).with_name('app-states.tsx.template'), source / 'dev-states/app-states.tsx')
for relative in ['home/HomeScreen.tsx', 'join/NameStep.tsx', 'call/ReadySheet.tsx', 'join/JoiningScreen.tsx']:
    path = source / relative
    text = path.read_text()
    # Preserve all native type references; only JSX View nodes become measured hosts.
    text = 'import { MeasuredView } from "../dev-states/measurement";\n' + text.replace('<View', '<MeasuredView').replace('</View>', '</MeasuredView>')
    if relative == 'join/JoiningScreen.tsx':
        text = text.replace('function Joining({', 'export function Joining({')
    if relative == 'join/NameStep.tsx':
        text = text.replace('<MeasuredView style={[styles.card,', '<MeasuredView testID="join.name-card" style={[styles.card,')
    path.write_text(text)
