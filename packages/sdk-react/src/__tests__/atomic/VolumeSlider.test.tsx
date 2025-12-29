import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent, act } from '@testing-library/react';
import { VolumeSlider } from '../../components/atomic/VolumeSlider';

describe('VolumeSlider', () => {
  it('renders correctly', () => {
    const { getByRole } = render(<VolumeSlider value={50} onChange={() => {}} />);
    expect(getByRole('slider').getAttribute('aria-valuenow')).toBe('50');
  });

  it.skip('calls onChange when slider moves', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<VolumeSlider value={50} onChange={onChange} muted={false} />);
    const slider = getByRole('slider') as HTMLInputElement;
    
    act(() => {
      fireEvent.change(slider, { target: { value: '75' } });
    });
    
    expect(onChange).toHaveBeenCalled();
  });

  it('handles mute toggle', () => {
    const onMuteToggle = vi.fn();
    const { getByLabelText } = render(
      <VolumeSlider value={50} onChange={() => {}} onMuteToggle={onMuteToggle} />
    );
    fireEvent.click(getByLabelText('Mute'));
    expect(onMuteToggle).toHaveBeenCalledTimes(1);
  });

  it('shows value when showValue is true', () => {
    const { getByText } = render(<VolumeSlider value={50} onChange={() => {}} showValue />);
    expect(getByText('50%')).toBeDefined();
  });

  it('shows unmute label when muted is true', () => {
    const { getByLabelText } = render(<VolumeSlider value={50} onChange={() => {}} muted />);
    expect(getByLabelText('Unmute')).toBeDefined();
  });
});
