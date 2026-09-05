const path = require("path");

describe("Editor Position", () => {
  let editor;
  let editorPosition;
  let goToLine;
  let statusBar;
  let workspaceElement;

  const updateDocument = () => lumine.views.performDocumentUpdate();
  const positionTile = () => statusBar?.querySelector(".editor-position") ?? null;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);

    await lumine.packages.activatePackage("status-bar");
    const pack = await lumine.packages.activatePackage("go-to-line");
    goToLine = pack.mainModule.activate();

    await lumine.workspace.open(path.join(__dirname, "fixtures", "sample.js"));
    editor = lumine.workspace.getActiveTextEditor();
    statusBar = workspaceElement.querySelector("status-bar");
    editorPosition = positionTile();
    updateDocument();
  });

  afterEach(async () => {
    lumine.config.unset("go-to-line.showInStatusBar");
    lumine.config.unset("go-to-line.statusBarTemplate");
    lumine.config.unset("go-to-line.customStatusBarTemplate");
    if (lumine.packages.isPackageActive("go-to-line")) {
      await lumine.packages.deactivatePackage("go-to-line");
    }
  });

  it("is present as soon as the package consumes the status bar", () => {
    expect(editorPosition).not.toBeNull();
    expect(editorPosition.textContent).toBe("1:1");
  });

  it("updates when the cursor moves", () => {
    editor.setCursorBufferPosition([1, 2]);
    updateDocument();
    expect(editorPosition.textContent).toBe("2:3");
  });

  it("shows the cursor and selection size with the default template", () => {
    editor.setText("abc\ndef");
    editor.setSelectedBufferRange([
      [0, 0],
      [1, 2],
    ]);
    updateDocument();
    expect(editorPosition.textContent).toBe("2:3 (2:6)");
  });

  it("respects the selection direction", () => {
    lumine.config.set("go-to-line.statusBarTemplate", "With Selection");
    editor.setSelectedBufferRange(
      [
        [0, 0],
        [1, 2],
      ],
      { reversed: true },
    );
    updateDocument();
    expect(editorPosition.textContent).toBe("2:3-1:1");
  });

  it("shows the number of cursors", () => {
    lumine.config.set("go-to-line.statusBarTemplate", "With Selection and Cursors");
    editor.setCursorBufferPosition([0, 0]);
    editor.addCursorAtBufferPosition([1, 2]);
    updateDocument();
    expect(editorPosition.textContent).toBe("2:3 #2");
  });

  it("renders a custom Liquid template", () => {
    lumine.config.set("go-to-line.statusBarTemplate", "Custom");
    lumine.config.set("go-to-line.customStatusBarTemplate", "{{ lines }} lines, {{ chars }} chars");
    editor.setText("abc\ndef");
    editor.setSelectedBufferRange([
      [0, 0],
      [1, 2],
    ]);
    updateDocument();
    expect(editorPosition.textContent).toBe("2 lines, 6 chars");
  });

  it("hides when a custom template renders empty", () => {
    lumine.config.set("go-to-line.statusBarTemplate", "Custom");
    lumine.config.set("go-to-line.customStatusBarTemplate", "{% if chars %}{{ chars }}{% endif %}");
    editor.setCursorBufferPosition([0, 0]);
    updateDocument();
    expect(editorPosition).toBeHidden();
  });

  it("hides when the active pane item is not a text editor", () => {
    lumine.workspace.getActivePane().activateItem(document.createElement("div"));
    updateDocument();
    expect(editorPosition).toBeHidden();
  });

  it("can be removed and restored without changing its status bar slot", () => {
    lumine.config.set("go-to-line.showInStatusBar", false);
    expect(positionTile()).toBeNull();

    lumine.config.set("go-to-line.showInStatusBar", true);
    editorPosition = positionTile();
    updateDocument();
    expect(editorPosition).not.toBeNull();
    expect(
      statusBar
        .getLeftTiles()
        .find((tile) => tile.getItem() === editorPosition)
        .getPriority(),
    ).toBe(510);
  });

  it("opens Go to Line when clicked", () => {
    expect(goToLine.panel.isVisible()).toBe(false);
    editorPosition.click();
    expect(goToLine.panel.isVisible()).toBe(true);
  });

  it("removes the tile when the package is deactivated", async () => {
    await lumine.packages.deactivatePackage("go-to-line");
    expect(positionTile()).toBeNull();
  });
});
