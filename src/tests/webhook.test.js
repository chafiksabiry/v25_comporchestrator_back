import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config/env.js';

const testServer = express();
const PORT = 3004;

// Générer une paire de clés Ed25519 pour les tests
const TEST_KEY_PAIR = crypto.generateKeyPairSync('ed25519');

// Fonction pour générer une signature Ed25519 valide pour les tests
function generateTelnyxSignature(payload, timestamp) {
    // 1. Créer le message à signer (même format que Telnyx)
    const toSign = `${timestamp}|${JSON.stringify(payload)}`;
    
    // 2. Signer avec notre clé privée de test
    const signature = crypto.sign(null, Buffer.from(toSign), TEST_KEY_PAIR.privateKey);
    
    // 3. Pour le debug, vérifier que la signature est valide avec notre clé publique
    const isValid = crypto.verify(
        null,
        Buffer.from(toSign),
        TEST_KEY_PAIR.publicKey,
        signature
    );
    
    console.log('🔑 Test signature verification:', isValid ? 'Valid' : 'Invalid');
    console.log('📝 Public key (base64):', TEST_KEY_PAIR.publicKey.toString('base64'));
    
    return signature.toString('base64');
}

// Exemple de payload webhook
const webhookPayload = {
    data: {
        event_type: "number_order.complete",
        id: "444c08d4-58b5-4d56-bbd9-bbcbedb5e6e6",
        occurred_at: "2025-09-29T16:33:46.468108Z",
        payload: {
            billing_group_id: null,
            connection_id: null,
            created_at: "2025-09-29T11:59:59.754968+00:00",
            customer_reference: null,
            id: "cb0964a5-babd-49ab-9996-6dc37c587736",
            messaging_profile_id: null,
            phone_numbers: [
                {
                    bundle_id: null,
                    country_code: "FR",
                    id: "7816af94-f409-4975-902b-75722f2639f8",
                    phone_number: "+33423330959",
                    phone_number_type: "local",
                    record_type: "number_order_phone_number",
                    regulatory_requirements: [
                        {
                            field_type: "textual",
                            field_value: "Chafik SABIRY, DIGITAL ASSURANCE, +33623984708",
                            requirement_id: "2708e569-696a-4fc7-9305-5fdb3eb9c7dd",
                            status: "approved"
                        },
                        {
                            field_type: "document",
                            field_value: "395ed4b2-8b62-442d-9535-8e977ae039be",
                            requirement_id: "1cfde0b1-f85e-4444-9c1a-413cfa3f079f",
                            status: "approved"
                        },
                        {
                            field_type: "address",
                            field_value: "2791538576658007998",
                            requirement_id: "b0075437-6966-4c79-ae8d-39e981e55ac7",
                            status: "approved"
                        },
                        {
                            field_type: "document",
                            field_value: "96d72216-c394-47c7-94e2-c8b692a56366",
                            requirement_id: "b0197fa1-c2fd-4500-9875-2c658b2396eb",
                            status: "approved"
                        }
                    ],
                    requirements_met: true,
                    requirements_status: "approved",
                    status: "success"
                }
            ],
            phone_numbers_count: 1,
            record_type: "number_order",
            requirements_met: true,
            status: "success",
            sub_number_orders_ids: [
                "dc723b79-9ab2-4a60-8768-d6a910ba9d59"
            ],
            updated_at: "2025-09-29T16:33:45.646289+00:00"
        }
    },
};

// Endpoint de test qui envoie un webhook
testServer.post('/test-webhook', async (req, res) => {
    try {
        // Timestamp d'il y a 6 minutes (devrait échouer car > 5 minutes)
/*         const timestamp = (Math.floor(Date.now() / 1000) - 360).toString();
        const signature = generateTelnyxSignature(webhookPayload, timestamp, config.webhookSecret); */

        console.log('🔐 use old signature:', "p19Tr0zTWfDVCRBHjxJR+HTYuUe8rWGKv/1G3sN6ezBx+n/qffmlv00gNdSuvi1U3Ce46r7R3IJNbOM55MjbAA==");
        console.log('⏰ use ole Timestamp:', "1759163628");

        // Envoyer le payload comme une chaîne brute
        const stringifiedPayload = JSON.stringify(webhookPayload);
        console.log('📝 Sending payload:', stringifiedPayload);

        // Envoyer la requête à notre API
        const response = await axios.post(
            'http://localhost:3003/api/phone-numbers/webhooks/telnyx/number-order',
            stringifiedPayload,
            {
                headers: {
                    'Content-Type': 'text/plain',
                    'Telnyx-Signature-Ed25519': "p19Tr0zTWfDVCRBHjxJR+HTYuUe8rWGKv/1G3sN6ezBx+n/qffmlv00gNdSuvi1U3Ce46r7R3IJNbOM55MjbAA==",
                    'Telnyx-Timestamp': "1759163628"
                }
            }
        );

        console.log('✅ Webhook test response:', response.data);
        res.json({ success: true, response: response.data });
    } catch (error) {
        console.error('❌ Webhook test error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// Endpoint pour tester un webhook avec statut "failed"
testServer.post('/test-webhook-failed', async (req, res) => {
    try {
        const failedPayload = {
            ...webhookPayload,
            data: {
                ...webhookPayload.data,
                payload: {
                    ...webhookPayload.data.payload,
                    status: "failed",
                    phone_numbers: [
                        {
                            ...webhookPayload.data.payload.phone_numbers[0],
                            status: "failed"
                        }
                    ]
                }
            }
        };

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = generateTelnyxSignature(failedPayload, timestamp, config.webhookSecret);

        const response = await axios.post(
            'http://localhost:3003/api/phone-numbers/webhooks/telnyx/number-order',
            failedPayload,
            {
                headers: {
                    'Content-Type': 'text/plain',
                    'Telnyx-Signature-Ed25519': signature,
                    'Telnyx-Timestamp': timestamp
                }
            }
        );

        console.log('✅ Failed webhook test response:', response.data);
        res.json({ success: true, response: response.data });
    } catch (error) {
        console.error('❌ Failed webhook test error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// Test avec un très vieux timestamp
testServer.post('/test-webhook-old', async (req, res) => {
    try {
        // Timestamp d'il y a 2 jours
        const timestamp = (Math.floor(Date.now() / 1000) - (2 * 24 * 60 * 60)).toString();
        const signature = generateTelnyxSignature(webhookPayload, timestamp);

        console.log('🔐 Generated signature:', signature);
        console.log('⏰ Old Timestamp:', timestamp);

        const response = await axios.post(
            'http://localhost:3003/api/phone-numbers/webhooks/telnyx/number-order',
            webhookPayload,
            {
                headers: {
                    'Content-Type': 'text/plain',
                    'Telnyx-Signature-Ed25519': signature,
                    'Telnyx-Timestamp': timestamp
                }
            }
        );

        console.log('✅ Webhook test response:', response.data);
        res.json({ success: true, response: response.data });
    } catch (error) {
        console.error('❌ Webhook test error:', error.response?.data || error.message);
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

// Démarrer le serveur de test
testServer.listen(PORT, () => {
    console.log(`🚀 Test server running on port ${PORT}`);
    console.log(`
📝 Available test endpoints:
1. Success test:  curl -X POST http://localhost:${PORT}/test-webhook
2. Failed test:   curl -X POST http://localhost:${PORT}/test-webhook-failed
3. Old timestamp: curl -X POST http://localhost:${PORT}/test-webhook-old
  `);
});