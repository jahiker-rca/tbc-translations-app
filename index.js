const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: process.env.CORS_ALLOWED_ORIGIN,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
}));
app.use(bodyParser.json());

// Configuration
const ADMIN_API_URL = `https://${process.env.SHOPIFY_SHOP_NAME}/admin/api/2025-07`;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// ============= HELPER FUNCTIONS =============
async function makeGraphQLRequest(query) {
    try {
        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );
        return response.data;
    } catch (error) {
        throw new Error(`GraphQL request failed: ${error.message}`);
    }
}

// Google Translate function
async function callGoogleTranslateAPI(text, fromLang, toLang) {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    const response = await axios.post(url, {
        q: text,
        source: fromLang,
        target: toLang,
        format: 'text'
    });
    return response.data.data.translations[0].translatedText;
}

// Function to translate metafield content preserving technical data
async function translateMetafieldContent(originalValue, targetLocale) {
    try {
        // Separar texto de datos técnicos
        const parts = originalValue.split('~~');
        const textPart = parts[0]; // Parte traducible
        const technicalPart = parts.slice(1).join('~~'); // Datos técnicos

        // Traducir solo la parte de texto
        const translatedText = await callGoogleTranslateAPI(textPart, 'en', targetLocale);

        // Recombinar con datos técnicos
        return technicalPart ? `${translatedText}~~${technicalPart}` : translatedText;
    } catch (error) {
        console.log('Google Translate failed:', error.message);
        return originalValue; // Fallback al original si falla
    }
}

// Function to get translatable content digest
async function getTranslatableContentDigest(productId, namespace, key) {
    try {
        const query = `{
            translatableResource(resourceId: "${productId}") {
                translatableContent {
                    key
                    value
                    digest
                    locale
                }
            }
        }`;

        const response = await makeGraphQLRequest(query);
        const metafieldKey = `metafields.${namespace}.${key}`;

        const translatableContent = response.data.translatableResource.translatableContent
            .find(content => content.key === metafieldKey);

        return translatableContent ? translatableContent.digest : null;
    } catch (error) {
        console.log('Failed to get translatable content digest:', error.message);
        return null;
    }
}

// Function to create translation with correct GraphQL mutation
async function createTranslationWithCorrectMutation(productId, namespace, key, translatedValue, targetLocale) {
    try {
        const digest = await getTranslatableContentDigest(productId, namespace, key);
        
        if (!digest) {
            console.log('Could not get translatableContentDigest - metafield may not be translatable');
            return null;
        }

        // Mutation exacta de la documentación
        const mutation = `
            mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                    userErrors {
                        message
                        field
                    }
                    translations {
                        key
                        value
                    }
                }
            }
        `;

        const variables = {
            resourceId: productId,
            translations: [
                {
                    locale: targetLocale,
                    key: `metafields.${namespace}.${key}`,
                    value: translatedValue,
                    translatableContentDigest: digest
                }
            ]
        };

        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            {
                query: mutation,
                variables: variables
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );

        console.log('GraphQL mutation response:', response.data);

        if (response.data.data?.translationsRegister?.userErrors?.length > 0) {
            console.log('Translation registration errors:', response.data.data.translationsRegister.userErrors);
            return null;
        }

        if (response.data.data?.translationsRegister?.translations?.length > 0) {
            console.log('Translation registered successfully via GraphQL');
            return response.data.data.translationsRegister.translations[0];
        }

        return null;
    } catch (error) {
        console.log('GraphQL translation registration failed:', error.response?.data || error.message);
        return null;
    }
}


// Function to register translation in Shopify (REST fallback)
async function registerTranslationInShopify(productId, namespace, key, translatedValue, targetLocale) {
    try {
        const numericId = productId.replace('gid://shopify/Product/', '');
        const metafieldKey = `metafields.${namespace}.${key}`;

        const translationData = {
            "translation": {
                "locale": targetLocale,
                "key": metafieldKey,
                "value": translatedValue,
                "translatable_id": parseInt(numericId),
                "translatable_type": "Product"
            }
        };

        const response = await axios.post(
            `${ADMIN_API_URL}/translations.json`,
            translationData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );

        console.log('Translation registered successfully via REST');
        return response.data;
    } catch (error) {
        console.log('REST translation registration failed:', error.response?.status, error.response?.data);
        return null;
    }
}

// Function to trigger auto-translation using different endpoints
async function triggerTranslateAndAdapt(productId, targetLocale = 'de') {
    const numericId = productId.replace('gid://shopify/Product/', '');
    const url = `${ADMIN_API_URL}/translatable_resources/${numericId}/translations.json`;
    const data = {
        "locale": targetLocale,
        "auto_translate": true
    };
    try {
        console.log(`Trying endpoint: ${url}`);
        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': ADMIN_TOKEN
            }
        });
        console.log(`Success with endpoint: ${url}`);
        return response.data;
    } catch (error) {
        console.log(`Failed endpoint ${url}: ${error.response?.status} - ${error.message}`);
        return null;
    }
}

// MAIN FUNCTION - Updated with correct GraphQL mutation
async function getOrCreateMetafieldTranslation(productId, namespace, key, targetLocale = 'de') {
    try {
        // 1. Check if translation already exists
        const checkQuery = `{
            translatableResource(resourceId: "${productId}") {
                translations(locale: "${targetLocale}") {
                    key
                    value
                }
            }
        }`;

        let response = await makeGraphQLRequest(checkQuery);
        const metafieldKey = `metafields.${namespace}.${key}`;
        const existingTranslation = response.data.translatableResource.translations
            .find(t => t.key === metafieldKey);

        if (existingTranslation) {
            return {
                value: existingTranslation.value,
                locale: targetLocale,
                isTranslated: true,
                source: 'existing_shopify_translation'
            };
        }

        // 2. Get original metafield value
        const originalQuery = `{
            product(id: "${productId}") {
                metafield(namespace: "${namespace}", key: "${key}") {
                    value
                }
            }
        }`;

        const originalResponse = await makeGraphQLRequest(originalQuery);
        const originalValue = originalResponse.data.product.metafield?.value;

        if (!originalValue) {
            throw new Error('Metafield not found');
        }

        // 3. Try Shopify auto-translation first
        console.log('Attempting to trigger auto-translation...');
        const autoTranslateResult = await triggerTranslateAndAdapt(productId, targetLocale);

        if (autoTranslateResult) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const afterAutoResponse = await makeGraphQLRequest(checkQuery);
            const autoTranslation = afterAutoResponse.data.translatableResource.translations
                .find(t => t.key === metafieldKey);

            if (autoTranslation) {
                return {
                    value: autoTranslation.value,
                    locale: targetLocale,
                    isTranslated: true,
                    source: 'shopify_auto_translation'
                };
            }
        }

        // 4. Use Google Translate
        console.log('Using Google Translate...');
        const googleTranslatedValue = await translateMetafieldContent(originalValue, targetLocale);

        // 5. Try to register using the correct GraphQL mutation
        console.log('Attempting to register translation using correct GraphQL mutation...');
        const mutationResult = await createTranslationWithCorrectMutation(
            productId, namespace, key, googleTranslatedValue, targetLocale
        );

        if (mutationResult) {
            return {
                value: googleTranslatedValue,
                locale: targetLocale,
                isTranslated: true,
                source: 'google_translate_registered_graphql',
                message: 'Translation created with Google Translate and registered in Shopify via GraphQL'
            };
        }

        // 6. If GraphQL fails, try REST API as fallback
        console.log('GraphQL failed, trying REST API...');
        const restResult = await registerTranslationInShopify(
            productId, namespace, key, googleTranslatedValue, targetLocale
        );

        if (restResult) {
            return {
                value: googleTranslatedValue,
                locale: targetLocale,
                isTranslated: true,
                source: 'google_translate_registered_rest',
                message: 'Translation created with Google Translate and registered in Shopify via REST'
            };
        }

        // 7. If all registration attempts fail, return Google translation anyway
        return {
            value: googleTranslatedValue,
            locale: targetLocale,
            isTranslated: true,
            source: 'google_translate_only',
            message: 'Translation created with Google Translate (not registered in Shopify due to API limitations)'
        };

    } catch (error) {
        throw new Error(`Failed to get or create metafield translation: ${error.message}`);
    }
}

// ============= ENDPOINTS =============
app.post('/api/get-metafield', async (req, res) => {
    try {
        const response = await axios.post(
            `${ADMIN_API_URL}/graphql.json`,
            { query: req.body.query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': ADMIN_TOKEN
                }
            }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get-translated-metafield', async (req, res) => {
    try {
        const { productId, namespace, key, locale = 'de' } = req.body;

        if (!productId || !namespace || !key) {
            return res.status(400).json({
                error: 'Missing required parameters: productId, namespace, key'
            });
        }

        const result = await getOrCreateMetafieldTranslation(
            productId,
            namespace,
            key,
            locale
        );

        res.json({
            success: true,
            value: result.value,
            locale: result.locale,
            isTranslated: result.isTranslated,
            source: result.source,
            requestedLocale: locale,
            metafieldKey: `${namespace}.${key}`,
            message: result.message || 'Translation retrieved/created successfully'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to get original metafield value
app.post('/api/get-original-metafield', async (req, res) => {
    try {
        const { productId, namespace, key } = req.body;

        if (!productId || !namespace || !key) {
            return res.status(400).json({
                error: 'Missing required parameters: productId, namespace, key'
            });
        }

        const query = `{
            product(id: "${productId}") {
                metafield(namespace: "${namespace}", key: "${key}") {
                    value
                    type
                }
            }
        }`;

        const response = await makeGraphQLRequest(query);
        const metafield = response.data.product.metafield;

        if (!metafield) {
            return res.status(404).json({
                error: 'Metafield not found'
            });
        }

        res.json({
            success: true,
            originalValue: metafield.value,
            type: metafield.type,
            metafieldKey: `${namespace}.${key}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
