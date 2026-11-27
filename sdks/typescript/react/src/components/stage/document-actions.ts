import { createContext, useContext } from "react";

export interface DocumentActions {
  /** Opens the file picker to replace the presented file; absent when the viewer can't present. */
  readonly presentAnother?: () => void;
}

export const DocumentActionsContext = createContext<DocumentActions>({});

export function useDocumentActions(): DocumentActions {
  return useContext(DocumentActionsContext);
}
