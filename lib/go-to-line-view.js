const { CompositeDisposable, Disposable, Point } = require("lumine");
const EditorPositionView = require("./editor-position-view");

const editorPositionPriority = 510;
const statusBarControllers = new Set();
let goToLineView = null;

const HELP_MESSAGE =
  'Enter a <row> or <row>:<column> to go there, or <row>:<column>-<row>:<column> to select. Separate multiple positions or ranges with commas.\nExamples: "3" for row 3, "2:7-4:1" for a selection, or "3,8:2,10:1-12:4" for multiple cursors and selections.';

class GoToLineView {
  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.inputDialogHost = lumine.workspace.addInputDialog(
      {
        infoMessage: HELP_MESSAGE,
        commands: {
          "go-to-line:navigate": {
            description: "Move the active editor to the entered positions and ranges.",
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
      { className: "go-to-line" },
    );
    this.inputDialog = this.inputDialogHost.getModel();
    this.subscriptions.add(
      this.inputDialog.onDidChangeQuery(() => this.navigate({ keepOpen: true })),
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

    // On the workspace, because Edit > Go to Line dispatches at whatever holds
    // focus. `open` already declines when there is no active editor to go to a
    // line in.
    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "go-to-line:toggle": {
          description: "Open or close the Go to Line prompt.",
          didDispatch: () => {
            this.toggle();
            return false;
          },
        },
      }),
    );
  }

  destroy() {
    this.subscriptions.dispose();
    return this.inputDialogHost.destroy();
  }

  toggle() {
    this.inputDialogHost.isVisible() ? this.close() : this.open();
  }

  open() {
    if (this.inputDialogHost.isVisible() || !lumine.workspace.getActiveTextEditor()) return;
    this.inputDialogHost.show();
  }

  close() {
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
    const firstCharacterColumn = editor.lineTextForBufferRow(clipped.row).search(/\S/);
    return new Point(clipped.row, Math.max(firstCharacterColumn, 0));
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
    return { range: [head, head], reversed: false, head };
  }

  navigate(options = {}) {
    const input = this.miniEditor.getText();
    const editor = lumine.workspace.getActiveTextEditor();
    if (!options.keepOpen) {
      this.close();
    }
    if (!editor || !input.length) return;

    const currentRow = editor.getCursorBufferPosition().row;
    const items = input
      .split(",")
      .filter((text) => text.length > 0)
      .map((text) => this.parseItem(editor, text, currentRow));
    if (items.length === 0) return;

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

    editor.scrollToBufferPosition(items.at(-1).head, { center: true });
  }
}

class StatusBarController {
  constructor(statusBar) {
    this.statusBar = statusBar;
    this.configSubscription = lumine.config.observe("go-to-line.showInStatusBar", (visible) => {
      if (visible) this.addEditorPosition();
      else this.removeEditorPosition();
    });
  }

  addEditorPosition() {
    if (this.editorPositionTile) return;
    this.editorPosition = new EditorPositionView();
    this.editorPositionTile = this.statusBar.addLeftTile({
      item: this.editorPosition.element,
      priority: editorPositionPriority,
    });
  }

  removeEditorPosition() {
    this.editorPositionTile?.destroy();
    this.editorPositionTile = null;
    this.editorPosition?.destroy();
    this.editorPosition = null;
  }

  destroy() {
    this.configSubscription?.dispose();
    this.configSubscription = null;
    this.removeEditorPosition();
    this.statusBar = null;
  }
}

module.exports = {
  activate() {
    if (!goToLineView) goToLineView = new GoToLineView();
    return goToLineView;
  },

  deactivate() {
    for (const controller of statusBarControllers) controller.destroy();
    statusBarControllers.clear();
    const destroyed = goToLineView?.destroy();
    goToLineView = null;
    return destroyed;
  },

  consumeStatusBar(statusBar) {
    const controller = new StatusBarController(statusBar);
    statusBarControllers.add(controller);
    return new Disposable(() => {
      statusBarControllers.delete(controller);
      controller.destroy();
    });
  },
};
