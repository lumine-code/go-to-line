const { CompositeDisposable, Disposable, Point } = require("lumine");
const EditorPositionView = require("./editor-position-view");

const editorPositionPriority = 510;
let statusBarControllers = new Map();
let active = false;
let goToLineViews = new Map();
let commandSubscription = null;
let facade = null;

const HELP_MESSAGE =
  'Enter a <row> or <row>:<column> to go there, or <row>:<column>-<row>:<column> to select. Separate multiple positions or ranges with commas.\nExamples: "3" for row 3, "2:7-4:1" for a selection, or "3,8:2,10:1-12:4" for multiple cursors and selections.';

class GoToLineView {
  constructor(window = lumine.workspace.getMainWindow()) {
    this.window = window;
    this.subscriptions = new CompositeDisposable();
    this.targetEditorSubscription = null;
    this.targetEditor = undefined;
    this.inputDialogHost = lumine.workspace.addInputDialog(
      {
        infoMessage: HELP_MESSAGE,
        commands: {
          "go-to-line:navigate": {
            description: "Move the captured editor to the entered positions and ranges.",
            didDispatch: () => this.navigate({ keepOpen: true }),
          },
        },
        actions: [
          {
            command: "go-to-line:navigate",
            context: "dialog",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
      },
      { className: "go-to-line", window },
    );
    this.inputDialog = this.inputDialogHost.getModel();
    this.subscriptions.add(
      this.inputDialog.onDidChangeQuery(() => this.navigate({ keepOpen: true })),
      this.inputDialog.onDidRequestCancel(() => {
        this.navigation = (this.navigation || 0) + 1;
      }),
      this.inputDialogHost.onDidHide(() => this.releaseTargetEditor()),
      new Disposable(() => this.releaseTargetEditor()),
    );
    this.miniEditor = this.inputDialog.getQueryEditor();
    this.subscriptions.add(
      this.miniEditor.onWillInsertText((arg) => {
        if (arg.text.match(/[^,\-0-9:]/)) {
          arg.cancel();
        }
      }),
    );

    // Create the (hidden) modal panel eagerly so `panel` is available before the
    // first toggle, matching the previous constructor behavior.
    this.panel = this.inputDialogHost.getPanel();
  }

  destroy() {
    this.navigation = (this.navigation || 0) + 1;
    this.subscriptions.dispose();
    return this.inputDialogHost.destroy();
  }

  toggle(editor) {
    this.inputDialogHost.isVisible() ? this.close() : this.open(editor);
  }

  open(editor = this.window.getEditorContainer().getActiveEmbeddedTextEditor()) {
    if (this.inputDialogHost.isVisible() || !editor || editor.isDestroyed()) return;
    this.navigation = (this.navigation || 0) + 1;
    this.targetEditor = editor;
    this.targetEditorSubscription = editor.onDidDestroy(() => this.close());
    this.inputDialogHost.show();
  }

  releaseTargetEditor() {
    this.targetEditorSubscription?.dispose();
    this.targetEditorSubscription = null;
    this.targetEditor = null;
  }

  close(preserveNavigation = false) {
    if (!preserveNavigation) this.navigation = (this.navigation || 0) + 1;
    if (!this.inputDialogHost.isVisible()) return;
    this.inputDialogHost.hide();
  }

  // Parse a `<row>` or `<row>:<column>` fragment into 0-based coordinates.
  // A missing row falls back to the current row; a missing column is returned
  // as -1 so the caller can decide how to resolve it.
  parseFragment(text, currentRow) {
    const [rowText = "", columnText = ""] = text.split(/:+/);
    const row = rowText.length > 0 ? parseInt(rowText, 10) - 1 : currentRow;
    const column = columnText.length > 0 ? parseInt(columnText, 10) - 1 : -1;
    return new Point(row, column);
  }

  resolvePosition(editor, position, firstCharacter = false) {
    const clipped = editor.clipBufferPosition([position.row, Math.max(position.column, 0)]);
    if (!firstCharacter) return clipped;
    const buffer = editor.getBuffer(),
      source = buffer.getTextSnapshot();
    const start = source.lineStart(clipped.row);
    const end = start + buffer.lineLengthForRow(clipped.row);
    const read = source.reader(4096);
    let offset = start;
    const scan = () => {
      const deadline = performance.now() + 4;
      const turnEnd = Math.min(end, offset + 65536);
      while (offset < end) {
        const text = read(offset).slice(0, end - offset);
        const column = text.search(/\S/);
        if (column >= 0) return new Point(clipped.row, offset + column - start);
        offset += text.length;
        if (offset < end && (offset >= turnEnd || performance.now() >= deadline)) return null;
      }
      return new Point(clipped.row, 0);
    };
    const result = scan();
    if (result) return result;
    const revision = buffer.getTextRevision(),
      navigation = this.navigation;
    return (async () => {
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (
          editor.isDestroyed() ||
          buffer.getTextRevision() !== revision ||
          this.navigation !== navigation
        )
          throw Object.assign(new Error("Navigation cancelled"), { name: "AbortError" });
        const point = scan();
        if (point) return point;
      }
    })();
  }

  parseItem(editor, text, currentRow) {
    const dashIndex = text.indexOf("-");

    // A complete `<start>-<end>` item selects a range. The normalized range is
    // stored separately from its direction so a comma-separated input can mix
    // forward and reversed selections.
    if (dashIndex >= 0 && text.slice(dashIndex + 1).length > 0) {
      const anchor = this.resolvePosition(
        editor,
        this.parseFragment(text.slice(0, dashIndex), currentRow),
      );
      const head = this.resolvePosition(
        editor,
        this.parseFragment(text.slice(dashIndex + 1), currentRow),
      );
      const reversed = head.isLessThan(anchor);
      return {
        range: reversed ? [head, anchor] : [anchor, head],
        reversed,
        head,
      };
    }

    // A plain position, or the start of an incomplete range while the user is
    // still typing, creates a cursor. Row-only items land on the first
    // non-whitespace character just like the original single-item form.
    const fragment = this.parseFragment(
      dashIndex >= 0 ? text.slice(0, dashIndex) : text,
      currentRow,
    );
    const head = this.resolvePosition(editor, fragment, fragment.column < 0);
    if (head?.then)
      return head.then((point) => ({ range: [point, point], reversed: false, head: point }));
    return { range: [head, head], reversed: false, head };
  }

  navigate(options = {}) {
    const navigation = (this.navigation = (this.navigation || 0) + 1);
    if (this.miniEditor.getBuffer().getLength() > 65536) {
      lumine.notifications.addWarning("Go To Line input is limited to 65,536 characters.");
      return;
    }
    const input = this.miniEditor.getText();
    // Direct facade callers may navigate before opening the prompt. Once it
    // has opened, navigation belongs to that opening's captured editor.
    const editor =
      this.targetEditor === undefined
        ? this.window.getEditorContainer().getActiveEmbeddedTextEditor()
        : this.targetEditor;
    if (!options.keepOpen) {
      this.close(true);
    }
    if (!editor || editor.isDestroyed() || !input.length) return;

    const currentRow = editor.getCursorBufferPosition().row;
    const fragments = input.split(",").filter((text) => text.length > 0);
    if (fragments.length > 2000) {
      lumine.notifications.addWarning("Go To Line supports at most 2,000 cursor destinations.");
      return;
    }
    const items = fragments.map((text) => this.parseItem(editor, text, currentRow));
    if (items.length === 0) return;
    const revision = editor.getBuffer().getTextRevision();
    const apply = (items) => {
      if (
        editor.isDestroyed() ||
        this.navigation !== navigation ||
        editor.getBuffer().getTextRevision() !== revision
      )
        return;
      const [first, ...rest] = items;
      editor.setSelectedBufferRange(first.range, {
        reversed: first.reversed,
        autoscroll: false,
      });
      for (const item of rest) {
        editor.addSelectionForBufferRange(item.range, {
          reversed: item.reversed,
          autoscroll: false,
        });
      }

      editor.scrollToBufferPosition(items.at(-1).head, { mode: "zone" });
    };
    if (items.some((item) => item?.then))
      return Promise.all(items).then(apply, (error) => {
        if (error.name !== "AbortError")
          lumine.notifications.addError("Could not navigate to the requested position", {
            detail: error.message,
          });
      });
    return apply(items);
  }
}

class StatusBarController {
  constructor(
    statusBar,
    { deferInitialUpdate = false, window = lumine.workspace.getMainWindow() } = {},
  ) {
    this.statusBar = statusBar;
    this.window = window;
    this.destroyed = false;
    const applyVisibility = (visible) => {
      if (visible) this.addEditorPosition();
      else this.removeEditorPosition();
    };
    if (deferInitialUpdate) {
      this.configSubscription = lumine.config.onDidChange(
        "go-to-line.showInStatusBar",
        ({ newValue }) => applyVisibility(newValue),
      );
      queueMicrotask(() => {
        if (!this.destroyed) applyVisibility(lumine.config.get("go-to-line.showInStatusBar"));
      });
    } else {
      this.configSubscription = lumine.config.observe(
        "go-to-line.showInStatusBar",
        applyVisibility,
      );
    }
  }

  addEditorPosition() {
    if (this.destroyed || this.editorPositionTile) return;
    const position = new EditorPositionView(this.window);
    if (this.destroyed) {
      position.destroy();
      return;
    }
    this.editorPosition = position;
    const tile = this.statusBar.addLeftTile({
      item: position.element,
      priority: editorPositionPriority,
    });
    if (this.destroyed || this.editorPosition !== position) tile.destroy();
    else this.editorPositionTile = tile;
  }

  removeEditorPosition() {
    this.editorPositionTile?.destroy();
    this.editorPositionTile = null;
    this.editorPosition?.destroy();
    this.editorPosition = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.configSubscription?.dispose();
    this.configSubscription = null;
    this.removeEditorPosition();
    this.statusBar = null;
  }
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "go-to-line",
      tips: [
        "You can jump straight to lines or ranges with {{ 'go-to-line:toggle' | keystroke }}",
        "The status bar shows the cursor position and selection size; click it to open Go to Line.",
      ],
    };
  },

  activate() {
    active = true;
    // Register the command synchronously, but defer construction of the modal
    // input host until the first actual toggle.
    const commands = {
      "go-to-line:toggle": {
        description: "Open or close the Go to Line prompt.",
        didDispatch: (event) => {
          const window =
            event.context?.window ??
            lumine.workspace.getFocusedWindow() ??
            lumine.workspace.getMainWindow();
          const editor = lumine.workspace.getTextEditorForElement(event.target, {
            includeMini: false,
          });
          if (!editor && !goToLineViews.get(window)?.inputDialogHost.isVisible()) return;
          ensureGoToLineView(window).toggle(editor);
          return false;
        },
      },
    };
    commandSubscription ||= new CompositeDisposable(
      lumine.commands.add("lumine-text-editor:not([mini])", commands),
      lumine.commands.add(".go-to-line", commands),
    );

    // Preserve the historical object-shaped return value while keeping its
    // expensive modal view lazy for callers that only need activation. Any
    // property access is an explicit request for the real view and is
    // delegated with the correct receiver.
    return (facade ||= new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === "then") return undefined;
        const view = ensureGoToLineView();
        const value = view[property];
        return typeof value === "function" ? value.bind(view) : value;
      },
    }));
  },

  deactivate() {
    active = false;
    const command = commandSubscription;
    const views = goToLineViews;
    const controllers = statusBarControllers;
    commandSubscription = null;
    goToLineViews = new Map();
    statusBarControllers = new Map();
    command?.dispose();
    for (const state of controllers.values()) {
      state.retired = true;
      state.controller.destroy();
    }
    controllers.clear();
    return Promise.all([...views.values()].map((view) => view.destroy()));
  },

  consumeStatusBar(service) {
    return service.observeWindows(
      (scopedStatusBar, context) => this.consumeWindowStatusBar(scopedStatusBar, context),
      { windows: "all" },
    );
  },

  consumeWindowStatusBar(statusBar, context) {
    if (!active) return new Disposable();
    const controllers = statusBarControllers;
    let state = controllers.get(statusBar);
    if (!state) {
      state = { refs: 0, retired: false, controller: null };
      controllers.set(statusBar, state);
      state.controller = new StatusBarController(statusBar, {
        deferInitialUpdate: true,
        window: context.window,
      });
    }
    state.refs++;
    return new Disposable(() => {
      if (state.retired || --state.refs > 0) return;
      state.retired = true;
      if (controllers.get(statusBar) === state) controllers.delete(statusBar);
      state.controller.destroy();
    });
  },
};

function ensureGoToLineView(window = lumine.workspace.getMainWindow()) {
  let view = goToLineViews.get(window);
  if (!view) {
    view = new GoToLineView(window);
    goToLineViews.set(window, view);
    view.subscriptions.add(
      window.onWillDestroy(() => {
        goToLineViews.delete(window);
        void view.destroy();
      }),
    );
  }
  return view;
}
