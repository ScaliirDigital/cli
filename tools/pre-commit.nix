_: {
  # Default
  end-of-file-fixer = {
    enable = true;
  };
  detect-private-keys.enable = true;

  # Nix
  alejandra.enable = true;
  deadnix.enable = true;
  statix.enable = true;

  # Web
  biome = {
    enable = true;
    types_or = [
      "javascript"
      "jsx"
      "ts"
      "tsx"
      "json"
      "vue"
      "astro"
    ];
  };
}
