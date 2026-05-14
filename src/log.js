function ts() {
  return new Date().toISOString();
}

export function logger(scope) {
  const prefix = `[${scope}]`;
  return {
    debug: (msg) => {
      if (process.env.PREWARNING_DEBUG)
        console.log(`${ts()} DEBUG ${prefix} ${msg}`);
    },
    info: (msg) => console.log(`${ts()} INFO  ${prefix} ${msg}`),
    warn: (msg) => console.warn(`${ts()} WARN  ${prefix} ${msg}`),
    error: (msg) => console.error(`${ts()} ERROR ${prefix} ${msg}`),
  };
}
