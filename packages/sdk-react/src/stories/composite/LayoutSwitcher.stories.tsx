import type { Meta, StoryObj } from '@storybook/react';
import { LayoutSwitcher } from '../../components/composite/LayoutSwitcher';

const meta: Meta<typeof LayoutSwitcher> = {
  title: 'Composite/LayoutSwitcher',
  component: LayoutSwitcher,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof LayoutSwitcher>;

export const Default: Story = {
  args: {
    layout: 'grid',
    onChange: (layout) => console.log('Layout changed to:', layout),
  },
};

export const Spotlight: Story = {
  args: {
    layout: 'spotlight',
    onChange: (layout) => console.log('Layout changed to:', layout),
  },
};

export const Disabled: Story = {
  args: {
    layout: 'grid',
    disabled: true,
    onChange: (layout) => console.log('Layout changed to:', layout),
  },
};
