const { CompositeDisposable, Disposable } = require("lumine");
let templateEngine;
function getTemplateEngine() {
  if (!templateEngine) {
    const { Liquid } = require("liquidjs");
    templateEngine = new Liquid({ jsTruthy: true });
  }
  return templateEngine;
}

const presetTemplates = Object.freeze({
  "Row and Column": ({ end }) => `${end.row}:${end.col}`,
  "Row and Column, Lines and Chars": ({ end, chars, lines, n }) =>
    `${end.row}:${end.col}${chars ? ` (${lines}:${chars})` : ""}${n > 1 ? ` #${n}` : ""}`,
  "With Selection": ({ start, end, chars }) =>
    `${start.row}:${start.col}${chars ? `-${end.row}:${end.col}` : ""}`,
  "With Selection and Cursors": ({ start, end, chars, n }) =>
    `${start.row}:${start.col}${chars ? `-${end.row}:${end.col}` : ""}${n > 1 ? ` #${n}` : ""}`,
});

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

module.exports = class EditorPositionView {
  constructor(window = lumine.workspace.getMainWindow()) {
    this.window = window;
    this.container = window.getEditorContainer();
    this.editor = this.container.getActiveEmbeddedTextEditor();
    this.viewUpdatePending = false;
    this.templateSelection = "";
    this.customTemplate = "";
    this.parsedTemplate = null;

    this.element = window.getDocument().createElement("status-bar-tile");
    this.element.classList.add("editor-position");
    this.element.setAttribute("data-context-menu-boundary", "");

    this.activeItemSubscription = this.container.observeActiveEmbeddedTextEditor((editor) => {
      this.editor = editor;
      this.subscribeToActiveTextEditor();
    });

    this.subscribeToConfig();
    this.subscribeToActiveTextEditor();

    this.tooltip = lumine.tooltips.add(this.element, {
      title: () => this.tooltipTitle(),
      html: false,
      keyBindingCommand: "go-to-line:toggle",
      keyBindingTarget: () => this.editor?.getElement() ?? null,
    });

    this.handleClick();
  }

  destroy() {
    this.activeItemSubscription.dispose();
    this.selectionSubscription?.dispose();
    this.tooltip.dispose();
    this.configSubscriptions?.dispose();
    this.clickSubscription.dispose();
    this.updateSubscription?.dispose();
  }

  subscribeToActiveTextEditor() {
    this.selectionSubscription?.dispose();
    const selectionsMarkerLayer = this.editor?.selectionsMarkerLayer;
    this.selectionSubscription = selectionsMarkerLayer?.onDidUpdate(this.scheduleUpdate.bind(this));
    this.scheduleUpdate();
  }

  subscribeToConfig() {
    this.configSubscriptions?.dispose();
    this.configSubscriptions = new CompositeDisposable();
    this.configSubscriptions.add(
      lumine.config.observe("go-to-line.statusBarTemplate", (value) => {
        this.templateSelection = value || "";
        this.updateTemplate();
      }),
      lumine.config.observe("go-to-line.customStatusBarTemplate", (value) => {
        this.customTemplate = value || "";
        this.updateTemplate();
      }),
    );
  }

  updateTemplate() {
    let template;
    if (this.templateSelection === "Custom") {
      template = this.customTemplate;
    } else if (Object.prototype.hasOwnProperty.call(presetTemplates, this.templateSelection)) {
      template = presetTemplates[this.templateSelection];
    } else {
      template = this.templateSelection;
    }
    this.parsedTemplate = null;
    if (typeof template === "function") {
      this.parsedTemplate = template;
    } else if (template && template.trim()) {
      try {
        this.parsedTemplate = getTemplateEngine().parse(template);
      } catch (error) {
        lumine.notifications.addWarning("go-to-line: invalid status bar template", {
          detail: error.message || String(error),
        });
      }
    }
    this.scheduleUpdate();
  }

  handleClick() {
    const clickHandler = (event) => {
      if (event.button !== 0 || (process.platform === "darwin" && event.ctrlKey)) return;
      if (this.editor) lumine.commands.dispatch(this.editor.getElement(), "go-to-line:toggle");
    };
    this.element.addEventListener("click", clickHandler);
    this.clickSubscription = new Disposable(() =>
      this.element.removeEventListener("click", clickHandler),
    );
  }

  tooltipTitle() {
    if (this.startRow == null) return "";
    let title;
    if (this.selectionEmpty) {
      title = `Line ${this.startRow}, Column ${this.startColumn}`;
    } else {
      title =
        `Line ${this.startRow}, Column ${this.startColumn} to Line ${this.endRow}, Column ${this.endColumn}` +
        ` — ${plural(this.selectionLines, "line")}, ${plural(this.selectionLength, "character")} selected`;
    }
    if (this.cursorCount > 1) title += ` — ${plural(this.cursorCount, "cursor")}`;
    return `${title}. Click to go to a line.`;
  }

  scheduleUpdate() {
    if (this.viewUpdatePending) return;
    this.viewUpdatePending = true;
    this.updateSubscription = lumine.views.updateDocument(() => {
      this.viewUpdatePending = false;
      this.update();
    });
  }

  update() {
    const editor = this.editor;

    if (!editor || !this.parsedTemplate) {
      this.startRow = null;
      this.element.textContent = "";
      this.element.classList.add("hide");
      return;
    }

    const selection = editor.getLastSelection();
    const tail = selection.getTailBufferPosition();
    const head = selection.getHeadBufferPosition();
    const range = selection.getBufferRange();
    this.selectionEmpty = range.isEmpty();
    this.startRow = tail.row + 1;
    this.startColumn = tail.column + 1;
    this.endRow = head.row + 1;
    this.endColumn = head.column + 1;

    // Count UTF-16 units, including the actual line endings, without allocating
    // the selected text. A selection may exceed the runtime's string limit.
    const buffer = editor.getBuffer();
    this.selectionLength =
      buffer.characterIndexForPosition(range.end) - buffer.characterIndexForPosition(range.start);
    this.selectionLines = this.selectionEmpty
      ? 0
      : range.getRowCount() - (range.end.column === 0 ? 1 : 0);
    this.cursorCount = editor.getCursors().length;

    let text;
    try {
      const data = {
        start: { row: this.startRow, col: this.startColumn },
        end: { row: this.endRow, col: this.endColumn },
        lines: this.selectionLines,
        chars: this.selectionLength,
        n: this.cursorCount,
      };
      text =
        typeof this.parsedTemplate === "function"
          ? this.parsedTemplate(data)
          : getTemplateEngine().renderSync(this.parsedTemplate, data);
    } catch {
      text = "";
    }

    if (text) {
      this.element.textContent = text;
      this.element.classList.remove("hide");
    } else {
      this.element.textContent = "";
      this.element.classList.add("hide");
    }
  }
};
