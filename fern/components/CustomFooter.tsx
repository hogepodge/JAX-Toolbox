// Custom footer for the JAX-Toolbox docs site, modeled on dynamo's
// fern/components/CustomFooter.tsx. Wire it in from docs.yml once you adopt
// custom React components (see https://buildwithfern.com/learn/docs/customization/custom-css-js).
import React from "react";

export default function CustomFooter(): React.ReactElement {
  const year = new Date().getFullYear();
  return (
    <footer className="jt-footer">
      <span>© {year} NVIDIA Corporation</span>
      <a href="https://github.com/NVIDIA/JAX-Toolbox" target="_blank" rel="noreferrer">
        GitHub
      </a>
      <a href="https://github.com/NVIDIA/JAX-Toolbox/blob/main/LICENSE.md" target="_blank" rel="noreferrer">
        License
      </a>
    </footer>
  );
}
