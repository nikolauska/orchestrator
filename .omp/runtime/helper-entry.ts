import { main } from "./remote-helper";

// Bun's API compiler does not consistently mark its Windows entry module as main.
process.exitCode = await main();
