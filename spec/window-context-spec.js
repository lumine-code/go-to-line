describe("go-to-line window contexts", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("go-to-line");
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("shows each local cursor and opens the prompt beside the invoking editor", async () => {
    const main = lumine.workspace.getMainWindow();
    const editor = await lumine.workspace.open();
    editor.setText("one\ntwo\nthree");
    editor.setCursorBufferPosition([1, 1]);
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const copy = editor.copy();
    copy.setCursorBufferPosition([2, 2]);
    extra.getEditorContainer().getActivePane().activateItem(copy, { activatePane: true });
    await conditionPromise(
      () => extra.getElement().querySelector(".editor-position")?.textContent === "3:3",
    );
    expect(main.getElement().querySelector(".editor-position").textContent).toBe("2:2");
    extra.getElement().querySelector(".editor-position").click();
    await conditionPromise(() => extra.getElement().querySelector(".go-to-line"));
    const query = extra.getElement().querySelector(".go-to-line lumine-text-editor").getModel();
    query.setText("1:2");
    expect(copy.getCursorBufferPosition().toArray()).toEqual([0, 1]);
    expect(editor.getCursorBufferPosition().toArray()).toEqual([1, 1]);
    lumine.commands.dispatch(editor.getElement(), "go-to-line:toggle");
    await conditionPromise(() => main.getElement().querySelector(".go-to-line"));
    expect(extra.getElement().querySelector(".go-to-line")).not.toBeNull();
  });
});
