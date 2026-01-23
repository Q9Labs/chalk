import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Tooltip } from '../../components/atomic/Tooltip';
import { IconButton } from '../../components/atomic/IconButton';
import { InformationCircleIcon } from '../../utils/icons';

const meta: Meta<typeof Tooltip> = {
  title: 'Atomic/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  argTypes: {
    position: {
      control: 'select',
      options: ['top', 'bottom', 'left', 'right'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const Default: Story = {
  args: {
    content: 'This is a tooltip',
    children: (
      <IconButton icon={<InformationCircleIcon size={18} />} aria-label="Info" variant="outline" />
    ),
  },
};

export const Positions: Story = {
  render: () => (
    <div className="flex gap-4 p-20">
      <Tooltip content="Top tooltip" position="top">
        <button type="button" className="px-4 py-2 bg-[var(--chalk-bg-tertiary)] rounded">Top</button>
      </Tooltip>
      <Tooltip content="Bottom tooltip" position="bottom">
        <button type="button" className="px-4 py-2 bg-[var(--chalk-bg-tertiary)] rounded">Bottom</button>
      </Tooltip>
      <Tooltip content="Left tooltip" position="left">
        <button type="button" className="px-4 py-2 bg-[var(--chalk-bg-tertiary)] rounded">Left</button>
      </Tooltip>
      <Tooltip content="Right tooltip" position="right">
        <button type="button" className="px-4 py-2 bg-[var(--chalk-bg-tertiary)] rounded">Right</button>
      </Tooltip>
    </div>
  ),
};
