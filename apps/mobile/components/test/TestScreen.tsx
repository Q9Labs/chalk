/**
 * Reusable test screen layout pattern
 *
 * ┌─────────────────────────┐
 * │ Hook Name               │
 * │ Description             │
 * ├─────────────────────────┤
 * │ [Test Controls]         │
 * │ - Buttons to trigger    │
 * │ - Input fields          │
 * ├─────────────────────────┤
 * │ [State Display]         │
 * │ - Current values        │
 * │ - Status indicators     │
 * ├─────────────────────────┤
 * │ [Debug Panel] (toggle)  │
 * │ - Raw state JSON        │
 * └─────────────────────────┘
 */

import { useState, type ReactNode } from 'react';
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface TestScreenProps {
  title: string;
  description: string;
  controls?: ReactNode;
  state?: ReactNode;
  debugData?: unknown;
}

export function TestScreen({
  title,
  description,
  controls,
  state,
  debugData,
}: TestScreenProps) {
  const [showDebug, setShowDebug] = useState(false);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
        </View>

        {controls && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Controls</Text>
            <View style={styles.sectionContent}>{controls}</View>
          </View>
        )}

        {state && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>State</Text>
            <View style={styles.sectionContent}>{state}</View>
          </View>
        )}

        {debugData !== undefined && (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.debugToggle}
              onPress={() => setShowDebug(!showDebug)}
            >
              <Text style={styles.sectionTitle}>Debug</Text>
              <Text style={styles.debugToggleText}>
                {showDebug ? 'Hide' : 'Show'}
              </Text>
            </TouchableOpacity>
            {showDebug && (
              <View style={styles.debugPanel}>
                <Text style={styles.debugText}>
                  {JSON.stringify(debugData, null, 2)}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

interface StatusBadgeProps {
  label: string;
  value: string | boolean | number;
  color?: 'green' | 'red' | 'yellow' | 'gray';
}

export function StatusBadge({ label, value, color = 'gray' }: StatusBadgeProps) {
  const displayValue = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  const badgeColor = typeof value === 'boolean' ? (value ? 'green' : 'red') : color;

  return (
    <View style={styles.statusBadge}>
      <Text style={styles.statusLabel}>{label}</Text>
      <View style={[styles.statusValue, styles[`badge_${badgeColor}`]]}>
        <Text style={styles.statusValueText}>{displayValue}</Text>
      </View>
    </View>
  );
}

interface TestButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}

export function TestButton({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: TestButtonProps) {
  return (
    <TouchableOpacity
      style={[
        styles.button,
        styles[`button_${variant}`],
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[styles.buttonText, disabled && styles.buttonTextDisabled]}
      >
        {title}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  description: {
    fontSize: 16,
    color: '#666',
    lineHeight: 22,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  sectionContent: {
    gap: 12,
  },
  debugToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  debugToggleText: {
    fontSize: 14,
    color: '#007AFF',
  },
  debugPanel: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  debugText: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    color: '#333',
  },
  statusBadge: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  statusLabel: {
    fontSize: 16,
    color: '#333',
  },
  statusValue: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusValueText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  badge_green: {
    backgroundColor: '#34C759',
  },
  badge_red: {
    backgroundColor: '#FF3B30',
  },
  badge_yellow: {
    backgroundColor: '#FFCC00',
  },
  badge_gray: {
    backgroundColor: '#8E8E93',
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  button_primary: {
    backgroundColor: '#007AFF',
  },
  button_secondary: {
    backgroundColor: '#f0f0f0',
  },
  button_danger: {
    backgroundColor: '#FF3B30',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  buttonTextDisabled: {
    color: '#999',
  },
});
