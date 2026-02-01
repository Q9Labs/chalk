import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { ControlBar } from '../../components/composite/ControlBar';

describe('ControlBar', () => {
  it('renders all default buttons', () => {
    const { getByLabelText } = render(<ControlBar />);
    expect(getByLabelText('Mute')).toBeDefined();
    expect(getByLabelText('Stop Video')).toBeDefined();
    expect(getByLabelText('Share Screen')).toBeDefined();
    expect(getByLabelText('Leave')).toBeDefined();
  });

  it('calls onToggleMute when mic button is clicked', () => {
    const onToggleMute = vi.fn();
    const { getByLabelText } = render(<ControlBar onToggleMute={onToggleMute} />);
    fireEvent.click(getByLabelText('Mute'));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('shows active state for recording', () => {
    const { getByLabelText } = render(<ControlBar isRecording={true} buttons={['record']} />);
    expect(getByLabelText('Stop Recording')).toBeDefined();
  });

  it('renders only specified buttons', () => {
    const { getByLabelText, queryByLabelText } = render(
      <ControlBar buttons={['mic', 'leave']} />
    );
    expect(getByLabelText('Mute')).toBeDefined();
    expect(getByLabelText('Leave')).toBeDefined();
    expect(queryByLabelText('Stop Video')).toBeNull();
  });
});
