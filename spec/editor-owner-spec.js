describe("Go To Line command editor ownership", () => {
  let first, second;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("go-to-line");
    first = await lumine.workspace.open();
    first.setText("first\nline\nlast\nend");
    lumine.workspace.getActivePane().splitRight();
    second = await lumine.workspace.open();
    second.setText("second\nline\nlast\nend");
    first.setCursorBufferPosition([0, 0]);
    second.setCursorBufferPosition([0, 0]);
    lumine.workspace.paneForItem(first).activate();
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
  });
  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("go-to-line"))
      await lumine.packages.unloadPackage("go-to-line");
    first?.destroy();
    second?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
  });
  async function prompt(target) {
    await lumine.commands.dispatch(target, "go-to-line:toggle");
    await conditionPromise(() => lumine.workspace.getModalPanels().some((p) => p.isVisible()));
    return lumine.workspace
      .getModalPanels()
      .find((p) => p.isVisible())
      .getItem();
  }
  async function navigate(model, query) {
    model.getQueryEditor().setText(query);
    await lumine.commands.dispatch(model.getQueryEditor().getElement(), "core:confirm");
  }
  it("keeps the opening editor when another pane becomes active before input", async () => {
    const model = await prompt(first.getElement());
    lumine.workspace.paneForItem(second).activate();
    await navigate(model, "3:2");
    expect(first.getCursorBufferPosition().toArray()).toEqual([2, 1]);
    expect(second.getCursorBufferPosition().toArray()).toEqual([0, 0]);
  });
  it("opens for the editor that dispatched the command from another pane", async () => {
    const model = await prompt(second.getElement());
    await navigate(model, "2:3");
    expect(second.getCursorBufferPosition().toArray()).toEqual([1, 2]);
    expect(first.getCursorBufferPosition().toArray()).toEqual([0, 0]);
  });
  it("retains active-editor fallback and range input for a workspace command", async () => {
    const model = await prompt(lumine.workspace.getElement());
    await navigate(model, "2:1-3:2");
    expect(first.getSelectedBufferRange().serialize()).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(second.getCursorBufferPosition().toArray()).toEqual([0, 0]);
  });
});
