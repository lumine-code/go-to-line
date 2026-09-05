const { CompositeDisposable, Disposable } = require("lumine");
const { Liquid } = require("liquidjs");

const templateEngine = new Liquid({ jsTruthy: true });
const presetTemplates = Object.freeze({
  "Row and Column": "{{ end.row }}:{{ end.col }}",
  "Row and Column, Lines and Chars":
    "{{ end.row }}:{{ end.col }}{% if chars %} ({{ lines }}:{{ chars }}){% endif %}{% if n > 1 %} #{{ n }}{% endif %}",
  "With Selection":
    "{{ start.row }}:{{ start.col }}{% if chars %}-{{ end.row }}:{{ end.col }}{% endif %}",
  "With Selection and Cursors":
    "{{ start.row }}:{{ start.col }}{% if chars %}-{{ end.row }}:{{ end.col }}{% endif %}{% if n > 1 %} #{{ n }}{% endif %}",
});

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

module.exports = class EditorPositionView {
  constructor() {
    this.viewUpdatePending = false;
    this.templateSelection = "";
    this.customTemplate = "";
    this.parsedTemplate = null;

    this.element = document.createElement("status-bar-tile");
    this.element.classList.add("editor-position");

    this.activeItemSubscription = lumine.workspace.onDidChangeActiveTextEditor(() =>
      this.subscribeToActiveTextEditor(),
    );

    this.subscribeToConfig();
    this.subscribeToActiveTextEditor();

    this.tooltip = lumine.tooltips.add(this.element, {
      title: () => this.tooltipTitle(),
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
    const selectionsMarkerLayer = lumine.workspace.getActiveTextEditor()?.selectionsMarkerLayer;
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
    if (template && template.trim()) {
      try {
        this.parsedTemplate = templateEngine.parse(template);
      } catch (error) {
        lumine.notifications.addWarning("go-to-line: invalid status bar template", {
          detail: error.message || String(error),
        });
      }
    }
    this.scheduleUpdate();
  }

  handleClick() {
    const clickHandler = () =>
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "go-to-line:toggle");
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
    return title;
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
    const editor = lumine.workspace?.getActiveTextEditor();

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

    this.selectionLength = selection.getText().length;
    this.selectionLines = this.selectionEmpty
      ? 0
      : range.getRowCount() - (range.end.column === 0 ? 1 : 0);
    this.cursorCount = editor.getCursors().length;

    let text;
    try {
      text = templateEngine.renderSync(this.parsedTemplate, {
        start: { row: this.startRow, col: this.startColumn },
        end: { row: this.endRow, col: this.endColumn },
        lines: this.selectionLines,
        chars: this.selectionLength,
        n: this.cursorCount,
      });
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
