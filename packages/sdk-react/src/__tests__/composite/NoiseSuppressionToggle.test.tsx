import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
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
    const { getByRole } = render(
      <NoiseSuppressionToggle enabled={true} onChange={() => {}} onLevelChange={() => {}} />
    );
    // Select renders as a button with the current value as its accessible name.
    expect(getByRole('button', { name: /medium/i })).toBeDefined();
  });

  it('reflects enabled state on the switch', () => {
    const { getByRole, rerender } = render(
      <NoiseSuppressionToggle enabled={false} onChange={() => {}} />
    );
    expect(getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    rerender(<NoiseSuppressionToggle enabled={true} onChange={() => {}} />);
    expect(getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
