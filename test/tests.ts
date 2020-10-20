// tslint:disable-next-line no-implicit-dependencies
import { assert } from "chai";

// import { ExampleHarhdatRuntimeEnvironmentField } from "../src/ExampleHarhdatRuntimeEnvironmentField";

import { useEnvironment } from "./helpers";

describe("Integration tests examples", function() {
  describe("Harhdat Runtime Environment extension", function() {
    useEnvironment(__dirname + "/harhdat-project");

    // it("It should add the example field", function() {
    //   assert.instanceOf(
    //     this.env.example,
    //     ExampleHarhdatRuntimeEnvironmentField
    //   );
    // });

    // it("The example filed should say hello", function() {
    //   assert.equal(this.env.example.sayHello(), "hello");
    // });
  });
});

describe("Unit tests examples", function() {
  describe("ExampleHarhdatRuntimeEnvironmentField", function() {
    describe("sayHello", function() {
      // it("Should say hello", function() {
      //   const field = new ExampleHarhdatRuntimeEnvironmentField();
      //   assert.equal(field.sayHello(), "hello");
      // });
    });
  });
});
