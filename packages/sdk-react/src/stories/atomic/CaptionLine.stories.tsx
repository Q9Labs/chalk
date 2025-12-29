import type { Meta, StoryObj } from '@storybook/react';
import { CaptionLine } from '../../components/atomic/CaptionLine';

const meta: Meta<typeof CaptionLine> = {
  title: 'Atomic/CaptionLine',
  component: CaptionLine,
  tags: ['autodocs'],
  argTypes: {
    position: {
      control: 'select',
      options: ['top', 'bottom'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof CaptionLine>;

export const Default: Story = {
  args: {
    text: 'This is a closed caption that would appear during the meeting.',
    speaker: 'Presenter',
    position: 'bottom',
  },
};

export const Top: Story = {
  args: {
    text: 'Important announcement: please mute your microphones.',
    speaker: 'Host',
    position: 'top',
  },
};
