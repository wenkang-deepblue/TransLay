import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadHostContext() {
  const hostContextSource = await readFile(
    new URL("../apps/addon/src/server/host_context.gs", import.meta.url),
    "utf8"
  );
  const context = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    getGoogleToken() {
      return "user-token";
    },
  };
  vm.createContext(context);
  vm.runInContext(hostContextSource, context);
  return context;
}

test("prepareOutputPresentation creates a SlidesApp copy without Drive REST or worker access", async () => {
  const context = await loadHostContext();
  const removedDefaults = [];
  const appendedSlides = [];
  const sourceSlides = [
    { getObjectId: () => "source-slide-1" },
    { getObjectId: () => "source-slide-2" },
  ];
  const target = {
    getId() {
      return "target-doc";
    },
    getUrl() {
      return "https://docs.google.com/presentation/d/target-doc/edit";
    },
    getSlides() {
      return [
        {
          remove() {
            removedDefaults.push("default-slide");
          },
        },
      ];
    },
    appendSlide(slide) {
      appendedSlides.push(slide.getObjectId());
    },
    saveAndClose() {
      appendedSlides.push("saved");
    },
  };
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSlides() {
          return sourceSlides;
        },
      };
    },
    create(name) {
      assert.equal(name, "Source deck (French)");
      return target;
    },
    openById(id) {
      assert.equal(id, "target-doc");
      return target;
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("prepareOutputPresentation must not call Drive REST");
    },
  };

  const prepared = context.prepareOutputPresentation("French");
  assert.equal(prepared.documentId, "target-doc");
  assert.equal(prepared.documentUrl, "https://docs.google.com/presentation/d/target-doc/edit");
  assert.equal(prepared.accessMode, "user_oauth_only");
  assert.deepEqual(removedDefaults, ["default-slide"]);
  assert.deepEqual(appendedSlides, ["source-slide-1", "source-slide-2", "saved"]);
});

test("prepareOutputPresentation reports SlidesApp preparation failures without Drive REST", async () => {
  const context = await loadHostContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
      };
    },
    create() {
      throw new Error("Slides create failed for source-doc");
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("prepareOutputPresentation must not call Drive REST");
    },
  };

  assert.throws(
    () => context.prepareOutputPresentation("French"),
    { message: "Failed to prepare the new presentation" }
  );
});

test("ensureCurrentPresentationReadyForUserOauthJob reads active Slides metadata without Drive REST", async () => {
  const context = await loadHostContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSlides() {
          return [{ getObjectId: () => "slide-1" }];
        },
      };
    },
  };
  context.UrlFetchApp = {
    fetch() {
      throw new Error("source readiness must not call Drive REST");
    },
  };

  const access = context.ensureCurrentPresentationReadyForUserOauthJob();
  assert.deepEqual(JSON.parse(JSON.stringify(access)), {
    documentId: "source-doc",
    documentName: "Source deck",
    accessMode: "user_oauth_only",
  });
});

test("ensureCurrentPresentationReadyForUserOauthJob hides low-level Slides errors", async () => {
  const context = await loadHostContext();
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getId() {
          return "source-doc";
        },
        getName() {
          return "Source deck";
        },
        getSlides() {
          throw new Error("internal failure for source-doc");
        },
      };
    },
  };

  assert.throws(
    () => context.ensureCurrentPresentationReadyForUserOauthJob(),
    { message: "Failed to read the current presentation for translation" }
  );
});

test("getCurrentSlideIndex returns the selected slide position", async () => {
  const context = await loadHostContext();
  const slides = [
    { getObjectId: () => "slide-1" },
    { getObjectId: () => "slide-2" },
    { getObjectId: () => "slide-3" },
  ];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getSelection() {
          return {
            getCurrentPage() {
              return { getObjectId: () => "slide-3" };
            },
          };
        },
        getSlides() {
          return slides;
        },
      };
    },
  };

  assert.equal(context.getCurrentSlideIndex(), 3);
});

test("getCurrentSlideIndex fails instead of defaulting to slide one", async () => {
  const context = await loadHostContext();
  const slides = [{ getObjectId: () => "slide-1" }];
  context.SlidesApp = {
    getActivePresentation() {
      return {
        getSelection() {
          return {
            getCurrentPage() {
              return null;
            },
          };
        },
        getSlides() {
          return slides;
        },
      };
    },
  };

  assert.throws(
    () => context.getCurrentSlideIndex(),
    { message: "No current slide page found" }
  );
});
