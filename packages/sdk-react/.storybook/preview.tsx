import React from 'react';
import type { Preview } from '@storybook/react';
import '../src/styles/styles.css';

const preview: Preview = {
  parameters: {
    controls: { expanded: true },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#1a1a2e' },
        { name: 'light', value: '#ffffff' },
      ],
    },
  },
  decorators: [
    (Story) => (
      <div data-chalk data-chalk-theme="dark" style={{ padding: '1rem' }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
