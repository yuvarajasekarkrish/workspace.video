/**
 * HTML `<textarea>` overlay for editing a sticky note's text. Pixi has no
 * text input primitive, so this is the only sane option for editable text
 * on the canvas — but it's also why MovementController.attachKeyboard grew
 * an ignore-guard: without one, typing "w"/"a"/"s"/"d" here would also walk
 * the avatar (see PixiStage's wiring of that guard).
 *
 * Commit and cancel are deliberately asymmetric, per the approved plan:
 *   - Ctrl/Cmd+Enter or clicking away (blur)  -> commit
 *   - plain Enter                              -> newline, never commits
 *   - Escape                                   -> CANCEL: discard the draft
 *     and leave the object's text exactly as it was before editing began
 * An accidental commit would silently destroy the previous text; an
 * accidental cancel only costs retyping — so the reflexive key (Escape)
 * must be the recoverable one, never the destructive one.
 */
export class NoteEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private originalText = "";
  private onCommit: ((text: string) => void) | null = null;

  isOpen(): boolean {
    return this.textarea !== null;
  }

  open(
    container: HTMLElement,
    screenRect: { x: number; y: number; width: number; height: number },
    initialText: string,
    onCommit: (text: string) => void,
  ): void {
    this.close(false); // any previous editor is abandoned (cancel), not committed

    this.originalText = initialText;
    this.onCommit = onCommit;

    const textarea = document.createElement("textarea");
    textarea.value = initialText;
    Object.assign(textarea.style, {
      position: "absolute",
      left: `${screenRect.x}px`,
      top: `${screenRect.y}px`,
      width: `${screenRect.width}px`,
      height: `${screenRect.height}px`,
      resize: "none",
      border: "2px solid #4f8cff",
      borderRadius: "4px",
      padding: "8px",
      boxSizing: "border-box",
      font: "13px ui-sans-serif, system-ui, sans-serif",
      zIndex: "50",
      outline: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    textarea.addEventListener("keydown", (e) => {
      // Stop propagation so a global window-level keydown listener (e.g.
      // Delete/Backspace for object deletion, or the movement guard) never
      // sees keys typed here at all — belt-and-suspenders alongside the
      // MovementController ignore-guard, which checks isOpen() directly.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.close(false);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.close(true);
      }
      // Plain Enter: default textarea behavior inserts a newline — no
      // special handling needed, and it must NOT commit.
    });
    textarea.addEventListener("blur", () => this.close(true));

    container.appendChild(textarea);
    this.textarea = textarea;
    textarea.focus();
    textarea.select();
  }

  private close(commit: boolean): void {
    const textarea = this.textarea;
    if (!textarea) return;
    const onCommit = this.onCommit;
    this.textarea = null;
    this.onCommit = null;

    textarea.remove();

    if (commit && onCommit && textarea.value !== this.originalText) {
      onCommit(textarea.value);
    }
  }

  /** Force-closes without committing — call on unmount so a stray textarea
   *  never survives navigating away from the room. */
  dispose(): void {
    this.close(false);
  }
}
