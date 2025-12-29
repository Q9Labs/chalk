import type { Meta, StoryObj } from '@storybook/react';
import { NoiseSuppressionToggle } from '../../components/composite/NoiseSuppressionToggle';

const meta: Meta<typeof NoiseSuppressionToggle> = {
  title: 'Composite/NoiseSuppressionToggle',
  component: NoiseSuppressionToggle,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof NoiseSuppressionToggle>;

export const Default: Story = {
  args: {
    enabled: false,
    level: 'medium',
  },
};

export const Enabled: Story = {
  args: {
    enabled: true,
    level: 'high',
  },
};
