import type { Meta, StoryObj } from '@storybook/react';
import { VolumeSlider } from '../../components/atomic/VolumeSlider';

const meta: Meta<typeof VolumeSlider> = {
  title: 'Atomic/VolumeSlider',
  component: VolumeSlider,
  tags: ['autodocs'],
  argTypes: {
    value: {
      control: { type: 'range', min: 0, max: 100 },
    },
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof VolumeSlider>;

export const Horizontal: Story = {
  args: {
    value: 50,
    orientation: 'horizontal',
    showValue: true,
  },
};

export const Vertical: Story = {
  render: (args) => (
    <div className="h-48 flex items-center justify-center">
      <VolumeSlider {...args} orientation="vertical" />
    </div>
  ),
  args: {
    value: 75,
    showValue: true,
  },
};

export const Muted: Story = {
  args: {
    value: 50,
    muted: true,
    orientation: 'horizontal',
  },
};
