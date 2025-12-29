import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { TranscriptLine } from '../../components/atomic/TranscriptLine';

describe('TranscriptLine', () => {
  const timestamp = new Date('2025-01-01T12:00:00');

  it('renders correctly', () => {
    const { getByText } = render(
      <TranscriptLine 
        speaker="John" 
        speakerId="p1" 
        text="Hello world" 
        timestamp={timestamp} 
      />
    );
    expect(getByText(/John:/)).toBeDefined();
    expect(getByText('Hello world')).toBeDefined();
    expect(getByText(/\[12:00\]/)).toBeDefined();
  });

  it('renders interim state', () => {
    const { getByRole } = render(
      <TranscriptLine 
        speaker="John" 
        speakerId="p1" 
        text="Interim text" 
        timestamp={timestamp} 
        isInterim 
      />
    );
    expect(getByRole('listitem')).toHaveClass('italic');
    expect(getByRole('listitem')).toHaveAttribute('aria-live', 'off');
  });

  it('hides speaker and timestamp when requested', () => {
    const { queryByText } = render(
      <TranscriptLine 
        speaker="John" 
        speakerId="p1" 
        text="Hello" 
        timestamp={timestamp} 
        showSpeaker={false}
        showTimestamp={false}
      />
    );
    expect(queryByText(/John:/)).toBeNull();
    expect(queryByText(/\[12:00\]/)).toBeNull();
  });
});
