import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { RecordingControls } from '../../components/composite/RecordingControls';

describe('RecordingControls', () => {
  it('renders correctly in ready state', () => {
    const { getByText, getByLabelText } = render(
      <RecordingControls isRecording={false} />
    );
    expect(getByText('READY')).toBeDefined();
    expect(getByLabelText('Start recording')).toBeDefined();
  });

  it('renders correctly in recording state', () => {
    const { getByLabelText, getByText } = render(
      <RecordingControls isRecording={true} duration={10} />
    );
    expect(getByText('REC')).toBeDefined();
    expect(getByLabelText('Stop recording')).toBeDefined();
    expect(getByText('00:10')).toBeDefined();
  });

  it('handles start action', () => {
    const onStart = vi.fn();
    const { getByLabelText } = render(
      <RecordingControls isRecording={false} onStart={onStart} />
    );
    fireEvent.click(getByLabelText('Start recording'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
