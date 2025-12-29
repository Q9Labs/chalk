import type { Meta, StoryObj } from '@storybook/react';
import { BackgroundEffectsPicker } from '../../components/composite/BackgroundEffectsPicker';

const meta: Meta<typeof BackgroundEffectsPicker> = {
  title: 'Composite/BackgroundEffectsPicker',
  component: BackgroundEffectsPicker,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof BackgroundEffectsPicker>;

const effects = [
  { id: 'none', type: 'none', label: 'None' },
  { id: 'blur', type: 'blur', label: 'Blur' },
  { id: 'office', type: 'image', label: 'Office', url: 'https://images.unsplash.com/photo-1497366216548-37526070297c' },
];

export const Default: Story = {
  args: {
    // @ts-ignore
    effects,
    selectedEffectId: 'none',
  },
};
