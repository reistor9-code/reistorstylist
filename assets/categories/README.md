# Occasion picker artwork

Source images for the category carousel, one folder per occasion. Filenames
are the category ids the flow uses — anything else is ignored.

    assets/categories/<occasion>/<category>.jpg

    occasion   work | vacation | casual | dinner | lounge
    category   tops | dresses | bottoms | jackets | jumpsuits | coords

Drop originals in at any size. `npm run cards` writes 1080x565 versions to
dashboard/public/categories/<occasion>/, which is what CATEGORY_IMAGES points
at, and picks a treatment per image:

  * a shot already near 1.91:1 is used as-is
  * a portrait or square shot is trimmed of its background and centred on a
    canvas of that same background colour

A category with no file falls back to the shared image on CATEGORIES, so an
occasion can be filled in one garment at a time.
