export function createBackdropDismiss(): {
  focused: boolean;
  attach(
    host: object,
    handle: {
      isFocused(): boolean;
      getBounds(): { row: number; col: number; width: number; height: number } | undefined;
    },
    dismiss: () => void,
  ): () => void;
};
