UPDATE command_panels
SET product_types = c.products
FROM clients c
WHERE command_panels.client_id = c.id
  AND (command_panels.product_types IS NULL OR command_panels.product_types = '{}')
  AND c.products IS NOT NULL
  AND c.products::text != '{}';

INSERT INTO command_panels (client_id, product_types)
SELECT c.id, c.products
FROM clients c
LEFT JOIN command_panels cp ON cp.client_id = c.id
WHERE cp.id IS NULL
  AND c.products IS NOT NULL
  AND c.products::text != '{}'
ON CONFLICT (client_id) DO NOTHING;
