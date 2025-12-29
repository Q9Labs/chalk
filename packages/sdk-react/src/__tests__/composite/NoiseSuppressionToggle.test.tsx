import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { NoiseSuppressionToggle } from '../../components/composite/NoiseSuppressionToggle';

describe('NoiseSuppressionToggle', () => {
  it('renders correctly', () => {
    const { getByText, getByRole } = render(
      <NoiseSuppressionToggle enabled={false} onChange={() => {}} />
    );
    expect(getByText('Noise Suppression')).toBeDefined();
    expect(getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('shows level selector when enabled', () => {
    const { getByLabelText } = render(
      <NoiseSuppressionToggle enabled={true} onChange={() => {}} />
    );
    expect(getByLabelText('Noise suppression level')).toBeDefined();
  });

  it('calls onChange when toggle clicked', () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <NoiseSuppressionToggle enabled={false} onChange={onChange} />
    );
    fireEvent.click(getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
