import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from '../../components/atomic/Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'Atomic/Toggle',
  component: Toggle,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Toggle>;

export const Off: Story = {
  args: {
    checked: false,
    label: 'Enable feature',
  },
};

export const On: Story = {
  args: {
    checked: true,
    label: 'Enable feature',
  },
};

export const Disabled: Story = {
  args: {
    checked: true,
    label: 'Disabled state',
    disabled: true,
  },
};
