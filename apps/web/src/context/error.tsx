import React, { createContext, useContext, useState, useCallback } from "react";
import { ErrorDialog } from "../components/ErrorDialog";

interface ErrorState {
  isOpen: boolean;
  message: string;
  traceId?: string;
}

interface ErrorContextType {
  showError: (message: string, traceId?: string) => void;
  hideError: () => void;
}

const ErrorContext = createContext<ErrorContextType | null>(null);

export function ErrorProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ErrorState>({
    isOpen: false,
    message: "",
  });

  const showError = useCallback((message: string, traceId?: string) => {
    setState({ isOpen: true, message, traceId });
  }, []);

  const hideError = useCallback(() => {
    setState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  return (
    <ErrorContext.Provider value={{ showError, hideError }}>
      {children}
      <ErrorDialog
        isOpen={state.isOpen}
        onClose={hideError}
        message={state.message}
        traceId={state.traceId}
      />
    </ErrorContext.Provider>
  );
}

export function useGlobalError() {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error("useGlobalError must be used within an ErrorProvider");
  }
  return context;
}
