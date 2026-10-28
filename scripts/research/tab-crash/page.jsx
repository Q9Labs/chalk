import React from 'react';
import { createRoot } from 'react-dom/client';
import { createSpaceClient } from '@q9labsai/chalk-client';
import { Chalk } from '@q9labsai/chalk-react';

let root, client;
window.__errors = [];
window.__mount = async () => {
  client = createSpaceClient({ space: window.__space, baseUrl: 'http://127.0.0.1:8080', getAccess: () => fetch('/access', { method: 'POST' }) });
  root = createRoot(document.getElementById('root'));
  root.render(<Chalk client={client} displayName="Crash research tutor" defaults={{ microphone: true, camera: true }}
    features={{ chat: true, participants: true, admission: true, screenShare: true, recording: true, whiteboard: true, reactions: true, handRaise: true, sounds: true }}
    onError={event => window.__errors.push({ code: event.error?.code, message: event.error?.message })} />);
  window.__client = client;
};
window.__join = () => client.join({ microphone: true, camera: true, displayName: 'Crash research tutor' }).catch(error => window.__errors.push({ code: error.code, message: error.message }));
window.__unmount = async () => {
  root.unmount();
  await client.leave().catch(error => window.__errors.push({ code: error.code, message: error.message }));
  client.dispose(); client = null; root = null; window.__client = null;
};
window.__state = () => ({ connection: client?.getSnapshot().connection, errors: window.__errors.slice(-6) });
await window.__mount();
window.__ready = true;
