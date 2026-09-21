const manifest = require("../package.json");

describe("go-to-line bootstrap", () => {
  it("keeps activation in JavaScript instead of manifest metadata", () => {
    expect(manifest.engines).toEqual({ lumine: "^1.0.0" });
  });

  it("defers construction of the modal input host until it is opened", () => {
    const addInputDialog = spyOn(lumine.workspace, "addInputDialog").and.callThrough();
    const facade = require("../lib/go-to-line-view").activate();

    expect(addInputDialog).not.toHaveBeenCalled();
    facade.toggle();
    expect(addInputDialog).toHaveBeenCalled();

    require("../lib/go-to-line-view").deactivate();
  });
});
