const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, 
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ButtonBuilder, 
    ButtonStyle, ChannelType, PermissionsBitField, AttachmentBuilder
} = require('discord.js');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const axios = require('axios');
require('dotenv').config();

// ===== CONFIG =====
const CONFIG = {
    PRODUCTS_FILE: path.join(__dirname, 'data', 'products.json'),
    STOCK_FILE: path.join(__dirname, 'data', 'stock.json'),
    RESELLERS_FILE: path.join(__dirname, 'data', 'resellers.json'),
    TRANSACTIONS_FILE: path.join(__dirname, 'data', 'transactions.json'),
    GLOBAL_DISCOUNT_FILE: path.join(__dirname, 'data', 'global_discount.json'),
    BALANCE_FILE: path.join(__dirname, 'data', 'balances.json'),
    BALANCE_TRANSACTIONS_FILE: path.join(__dirname, 'data', 'balance_transactions.json'),
    CUSTOM_PAYMENTS_FILE: path.join(__dirname, 'data', 'custom_payments.json'),
    ANALYTICS_FILE: path.join(__dirname, 'data', 'analytics.json'),
    GIVEAWAYS_FILE: path.join(__dirname, 'data', 'giveaways.json'),
    
            TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || '1411371410349228212',
    LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1267993296836366366',
    TICKETS_FILE: path.join(__dirname, 'data', 'tickets.json'),
    PAYMENT_LOG_CHANNEL_ID: '1378367871578800159',
    CUSTOMER_ROLE_ID: '1268000387827503176',
    
    CRYPTO_PRICES: { bitcoin: 620000, litecoin: 530 }, // Preços em BRL
    PAYMENT_TIMEOUT: 3600000,
    CHECK_INTERVAL: 15000,
    RESELLER_DISCOUNT: 0.5,
    MAX_INTERACTIONS_PER_USER: 5,
    INTERACTION_COOLDOWN: 3000
};

// ===== INIT EFI =====
let efi = null;
try {
    const EfiPay = require('sdk-node-apis-efi');
    efi = new EfiPay({
        sandbox: false,
        client_id: process.env.EFI_CLIENT_ID,
        client_secret: process.env.EFI_CLIENT_SECRET,
        certificate: './certificado.p12',
    });
    console.log('✅ EFI Pay configurado');
} catch (error) {
    console.warn('⚠️ EFI Pay não disponível:', error.message);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pixPayments = new Map();
const customPixPayments = new Map();
const activeInteractions = new Map();
const tempFiles = new Set();

// ===== GIVEAWAY SYSTEM =====
const GiveawaySystem = {
    async load() {
        return await Utils.loadJSON(CONFIG.GIVEAWAYS_FILE, {});
    },
    
    async save(data) {
        await Utils.saveJSON(CONFIG.GIVEAWAYS_FILE, data);
    },
    
    async create({ prize, winners, duration, host, hostTag, channelId, guildId }) {
        const id = `GW-${Math.random().toString(36).substr(2, 8).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        const endTime = Date.now() + duration;
        const giveaway = {
            id, prize, winners: [], winnerCount: winners, endTime, host, hostTag, channelId, guildId,
            participants: [], status: 'active', createdAt: Date.now(), messageId: null
        };
        const giveaways = await this.load();
        giveaways[id] = giveaway;
        await this.save(giveaways);
        return giveaway;
    },
    
    async join(id, userId, userTag) {
        const giveaways = await this.load();
        const g = giveaways[id];
        if (!g || g.status !== 'active') return false;
        if (g.participants.find(p => p.userId === userId)) return false;
        g.participants.push({ userId, userTag, joinedAt: Date.now() });
        await this.save(giveaways);
        console.log(`✅ Participante adicionado: ${userTag} ao sorteio ${id}. Total: ${g.participants.length}`);
        return true;
    },
    
    async leave(id, userId) {
        const giveaways = await this.load();
        const g = giveaways[id];
        if (!g || g.status !== 'active') return false;
        g.participants = g.participants.filter(p => p.userId !== userId);
        await this.save(giveaways);
        return true;
    },
    
    async end(id) {
        const giveaways = await this.load();
        const g = giveaways[id];
        if (!g || g.status !== 'active') return false;
        g.status = 'ended';
        
        console.log(`🏁 Finalizando sorteio ${id} com ${g.participants.length} participantes`);
        
        // Sorteia múltiplos vencedores
        if (g.participants.length > 0) {
            const shuffled = [...g.participants].sort(() => Math.random() - 0.5);
            const winnerCount = Math.min(g.winnerCount, g.participants.length);
            g.winners = shuffled.slice(0, winnerCount);
            console.log(`🎉 Vencedores sorteados: ${g.winners.map(w => w.userTag).join(', ')}`);
        } else {
            console.log(`⚠️ Nenhum participante no sorteio ${id}`);
        }
        
        g.endedAt = Date.now();
        await this.save(giveaways);
        return g;
    },
    
    async get(id) {
        const giveaways = await this.load();
        return giveaways[id];
    }
};

// ===== CUSTOMER ROLE SYSTEM =====
const CustomerRoleSystem = {
    async giveCustomerRole(guild, userId) {
        try {
            const member = await guild.members.fetch(userId);
            const role = guild.roles.cache.get(CONFIG.CUSTOMER_ROLE_ID);
            
            if (!role) {
                console.warn(`⚠️ Cargo de cliente não encontrado: ${CONFIG.CUSTOMER_ROLE_ID}`);
                return false;
            }
            
            if (member.roles.cache.has(CONFIG.CUSTOMER_ROLE_ID)) {
                console.log(`✅ ${member.user.tag} já possui o cargo de cliente`);
                return true;
            }
            
            await member.roles.add(role);
            console.log(`✅ Cargo de cliente adicionado para: ${member.user.tag}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Erro ao adicionar cargo de cliente para ${userId}:`, error);
            return false;
        }
    }
};

// ===== ANALYTICS SYSTEM =====
const AnalyticsSystem = {
    async load() {
        return await Utils.loadJSON(CONFIG.ANALYTICS_FILE, {
            totalSales: 0,
            totalRevenue: 0,
            totalCustomers: 0,
            dailyStats: {},
            productStats: {},
            customerStats: {},
            paymentMethodStats: {},
            monthlyRevenue: {},
            lastUpdated: new Date().toISOString()
        });
    },

    async save(data) {
        data.lastUpdated = new Date().toISOString();
        await Utils.saveJSON(CONFIG.ANALYTICS_FILE, data);
    },

    async recordSale(saleData) {
        try {
            const analytics = await this.load();
            const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const month = date.substring(0, 7); // YYYY-MM
            const revenue = parseFloat(saleData.price.replace(/[^0-9.]/g, ''));

            // Estatísticas gerais
            analytics.totalSales++;
            analytics.totalRevenue += revenue;

            // Estatísticas diárias
            if (!analytics.dailyStats[date]) {
                analytics.dailyStats[date] = { sales: 0, revenue: 0, customers: new Set() };
            } else if (!('add' in analytics.dailyStats[date].customers)) {
                // Corrige se virou array
                analytics.dailyStats[date].customers = new Set(analytics.dailyStats[date].customers);
            }
            analytics.dailyStats[date].sales++;
            analytics.dailyStats[date].revenue += revenue;
            analytics.dailyStats[date].customers.add(saleData.userId);

            // Estatísticas por produto
            const productKey = `${saleData.product} - ${saleData.plan}`;
            if (!analytics.productStats[productKey]) {
                analytics.productStats[productKey] = { sales: 0, revenue: 0, lastSale: null };
            }
            analytics.productStats[productKey].sales++;
            analytics.productStats[productKey].revenue += revenue;
            analytics.productStats[productKey].lastSale = new Date().toISOString();

            // Estatísticas por cliente
            if (!analytics.customerStats[saleData.userId]) {
                analytics.customerStats[saleData.userId] = {
                    username: saleData.userTag,
                    totalSpent: 0,
                    totalPurchases: 0,
                    firstPurchase: new Date().toISOString(),
                    lastPurchase: null,
                    favoriteProducts: {}
                };
            }
            analytics.customerStats[saleData.userId].totalSpent += revenue;
            analytics.customerStats[saleData.userId].totalPurchases++;
            analytics.customerStats[saleData.userId].lastPurchase = new Date().toISOString();
            analytics.customerStats[saleData.userId].username = saleData.userTag;

            // Produto favorito do cliente
            if (!analytics.customerStats[saleData.userId].favoriteProducts[productKey]) {
                analytics.customerStats[saleData.userId].favoriteProducts[productKey] = 0;
            }
            analytics.customerStats[saleData.userId].favoriteProducts[productKey]++;

            // Estatísticas por método de pagamento
            if (!analytics.paymentMethodStats[saleData.paymentMethod]) {
                analytics.paymentMethodStats[saleData.paymentMethod] = { sales: 0, revenue: 0 };
            }
            analytics.paymentMethodStats[saleData.paymentMethod].sales++;
            analytics.paymentMethodStats[saleData.paymentMethod].revenue += revenue;

            // Receita mensal
            if (!analytics.monthlyRevenue[month]) {
                analytics.monthlyRevenue[month] = { revenue: 0, sales: 0 };
            }
            analytics.monthlyRevenue[month].revenue += revenue;
            analytics.monthlyRevenue[month].sales++;

            // Converter Sets para arrays para salvamento JSON
            for (const dateKey in analytics.dailyStats) {
                if (analytics.dailyStats[dateKey].customers instanceof Set) {
                    analytics.dailyStats[dateKey].customers = Array.from(analytics.dailyStats[dateKey].customers);
                }
            }

            // Atualizar total de clientes únicos
            const allCustomers = new Set();
            Object.keys(analytics.customerStats).forEach(customerId => allCustomers.add(customerId));
            analytics.totalCustomers = allCustomers.size;

            await this.save(analytics);
            console.log(`📊 Venda registrada no analytics: ${saleData.userTag} - ${productKey} - R$ ${revenue.toFixed(2)}`);

        } catch (error) {
            console.error('❌ Erro registrando venda no analytics:', error);
        }
    },

    async getTopProducts(limit = 10) {
        const analytics = await this.load();
        return Object.entries(analytics.productStats)
            .sort(([,a], [,b]) => b.revenue - a.revenue)
            .slice(0, limit)
            .map(([product, stats]) => ({ product, ...stats }));
    },

    async getTopCustomers(limit = 10) {
        const analytics = await this.load();
        return Object.entries(analytics.customerStats)
            .sort(([,a], [,b]) => b.totalSpent - a.totalSpent)
            .slice(0, limit)
            .map(([userId, stats]) => ({ userId, ...stats }));
    },

    async getDailyStats(days = 30) {
        const analytics = await this.load();
        const today = new Date();
        const stats = [];

        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            const dayStats = analytics.dailyStats[dateStr] || { sales: 0, revenue: 0, customers: [] };
            stats.push({
                date: dateStr,
                sales: dayStats.sales,
                revenue: dayStats.revenue,
                uniqueCustomers: Array.isArray(dayStats.customers) ? dayStats.customers.length : 0
            });
        }

        return stats;
    },

    async getMonthlyRevenue() {
        const analytics = await this.load();
        return Object.entries(analytics.monthlyRevenue)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([month, stats]) => ({ month, ...stats }));
    },

    async getPaymentMethodStats() {
        const analytics = await this.load();
        return Object.entries(analytics.paymentMethodStats)
            .sort(([,a], [,b]) => b.revenue - a.revenue)
            .map(([method, stats]) => ({ method, ...stats }));
    },

    async getSummary() {
        const analytics = await this.load();
        const today = new Date().toISOString().split('T')[0];
        const todayStats = analytics.dailyStats[today] || { sales: 0, revenue: 0, customers: [] };
        
        // Calcular crescimento mensal
        const currentMonth = new Date().toISOString().substring(0, 7);
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        const lastMonthStr = lastMonth.toISOString().substring(0, 7);
        
        const currentMonthRevenue = analytics.monthlyRevenue[currentMonth]?.revenue || 0;
        const lastMonthRevenue = analytics.monthlyRevenue[lastMonthStr]?.revenue || 0;
        const monthlyGrowth = lastMonthRevenue > 0 ? ((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue * 100) : 0;

        return {
            totalSales: analytics.totalSales,
            totalRevenue: analytics.totalRevenue,
            totalCustomers: analytics.totalCustomers,
            todaySales: todayStats.sales,
            todayRevenue: todayStats.revenue,
            todayCustomers: Array.isArray(todayStats.customers) ? todayStats.customers.length : 0,
            monthlyGrowth: monthlyGrowth,
            averageOrderValue: analytics.totalSales > 0 ? analytics.totalRevenue / analytics.totalSales : 0,
            topPaymentMethod: Object.entries(analytics.paymentMethodStats)
                .sort(([,a], [,b]) => b.revenue - a.revenue)[0]?.[0] || 'N/A'
        };
    }
};

// ===== COMPONENT BUILDER =====
class ComponentBuilder {
    static buildStore() {
        // Nova embed usando o formato especificado pelo usuário - apenas a embed da loja
        const components = [
            {
                type: 9,
                accessory: {
                    type: 2,
                    style: 2,
                    label: "Compre Aqui",
                    emoji: null,
                    disabled: false,
                    custom_id: "1defe44681204b489b026465428b8785"
                },
                components: [
                    {
                        type: 10,
                        content: "# - Compras — Root@Unk"
                    }
                ]
            },
            {
                type: 10,
                content: "Antes de adquirir qualquer um de nossos serviços, recomendamos sempre verificar o status do produto. Assim, você garante que está ciente das informações e condições mais recentes.\n- 🛒 Em caso de dúvidas ou para obter mais detalhes, nossa equipe está à disposição para ajudar!\n- ⚖️ Lembre-se: os termos de compra se aplicam a todas as aquisições, independentemente do serviço escolhido."
            }
        ];

        return { type: 17, accent_color: null, spoiler: false, components };
    }

    static buildShoppingCart(products = null, selectedPayment = null) {
        const components = [
            {
                type: 10,
                content: "# 🛒 Carrinho de Compras — Root@Unk"
            }
        ];

        if (!selectedPayment) {
            // Primeira etapa: Seleção de método de pagamento
            components.push({
                type: 10,
                content: "**Primeiro, selecione seu método de pagamento:**"
            });

            const paymentOptions = [
                { label: 'PIX', value: 'pix', description: 'Pagamento instantâneo via PIX' },
                { label: 'Bitcoin', value: 'bitcoin', description: 'Pagamento via Bitcoin' },
                { label: 'Litecoin', value: 'litecoin', description: 'Pagamento via Litecoin' },
            ];

            components.push({
                type: 1,
                components: [{
                    type: 3,
                    custom_id: 'cart_payment_select',
                    placeholder: '💳 Escolha seu método de pagamento',
                    options: paymentOptions
                }]
            });
        } else {
            // Segunda etapa: Seleção de produtos
            components.push({
                type: 10,
                content: `**Método de pagamento:** ${Utils.getPaymentDisplay(selectedPayment)}\n\n**Agora, selecione os produtos que deseja comprar:**`
            });

            if (products && products.length > 0) {
                const productOptions = products.map(product => ({
                    label: product.titulo,
                    value: product.id,
                    description: `A partir de R$ ${Math.min(...product.subprodutos.map(sub => sub.preco)).toFixed(2)}`
                }));

                components.push({
                    type: 1,
                    components: [{
                        type: 3,
                        custom_id: `cart_product_select_${selectedPayment}`,
                        placeholder: '🎮 Escolha seus produtos',
                        options: productOptions
                    }]
                });
            } else {
                components.push({
                    type: 10,
                    content: "⚠️ **Nenhum produto disponível no momento.**"
                });
            }
        }

        // Removido botão de deletar canal conforme solicitado

        return { type: 17, accent_color: null, spoiler: false, components };
    }

    static buildCartSummary(cart, showAddMore = true) {
        if (cart.items.length === 0) {
            // Não mostrar carrinho vazio - retornar null
            return null;
        }

        // Construir texto dos itens
        let itemsText = "\n**Método de Pagamento:** ";
        itemsText += cart.paymentMethod ? Utils.getPaymentDisplay(cart.paymentMethod) : "*[Não selecionado]*";
        itemsText += "\n🛒 **Itens no Carrinho:**\n\n";

        cart.items.forEach((item, index) => {
            itemsText += ` **Produto:** ${item.productTitle} - ${item.subproductName}\n`;
            itemsText += ` **Valor Unitário:** R$ ${item.price.toFixed(2)} x ${item.quantity}\n`;
            itemsText += ` **Total:** R$ ${(item.price * item.quantity).toFixed(2)}\n\n`;
        });

        itemsText += ` **Valor Final:** R$ ${cart.total.toFixed(2)}`;

        // Primeiro componente - Cabeçalho com botão do site
        const mainComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 5,
                        label: "Nosso Site",
                        emoji: null,
                        disabled: false,
                        url: "https://rootunk.store"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🛒 **Seu Carrinho**"
                        }
                    ]
                },
                {
                    type: 10,
                    content: itemsText
                }
            ]
        };

        // Segundo componente - Botões de ação
        const actionButtons = [];
        
        if (showAddMore) {
            actionButtons.push({
                type: 2,
                style: 2,
                label: "➕ Adicionar Mais Produtos",
                emoji: null,
                disabled: false,
                custom_id: "add_more_products"
            });
        }

        actionButtons.push({
            type: 2,
            style: 3,
            label: "✅ Finalizar Compra",
            emoji: null,
            disabled: false,
            custom_id: "finalize_purchase"
        });

        const buttonsComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 1,
                    components: actionButtons
                }
            ]
        };

        // Terceiro componente - Remover itens (se houver)
        const components = [mainComponent, buttonsComponent];

        if (cart.items.length > 0) {
            const removeOptions = cart.items.map((item, index) => ({
                label: `${item.productTitle} - ${item.subproductName}`,
                value: `remove_${item.productId}_${item.subIndex}`,
                description: `Remover 1 unidade (${item.quantity}x R$ ${item.price.toFixed(2)})`
            }));

            const removeComponent = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 1,
                        components: [{
                            type: 3,
                            custom_id: 'remove_item_select',
                            placeholder: '🗑️ Remover item do carrinho',
                            options: removeOptions
                        }]
                    }
                ]
            };

            components.push(removeComponent);
        }

        return components;
    }

    static buildProductCatalog(paymentMethod, options) {
        return {
            type: 17,
            components: [
                { type: 10, content: `# Nossos Produtos - ${Utils.getPaymentDisplay(paymentMethod)}` },
                { type: 1, components: [{ type: 3, custom_id: `product_select_${paymentMethod}`, placeholder: 'Escolha seu produto favorito', options }] }
            ]
        };
    }

    static buildProductDetails(product, paymentMethod, options) {
        const components = [
            { type: 10, content: `# ${product.titulo}` },
            { type: 14, divider: true, spacing: 1 }
        ];
        
        // Adicionar descrição dividida se for muito longa
        const descricao = product.descricao || '';
        if (descricao.length > 2000) {
            // Dividir descrição longa
            let remainingDesc = descricao;
            while (remainingDesc.length > 0) {
                let part = remainingDesc.substring(0, 2000);
                if (remainingDesc.length > 2000) {
                    const lastNewline = part.lastIndexOf('\n');
                    if (lastNewline > 1600) {
                        part = remainingDesc.substring(0, lastNewline);
                    }
                }
                components.push({ type: 10, content: part });
                remainingDesc = remainingDesc.substring(part.length);
                if (remainingDesc.length > 0) {
                    components.push({ type: 14, divider: false, spacing: 1 });
                }
            }
        } else {
            components.push({ type: 10, content: descricao });
        }
        
        components.push(
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: '**Escolha seu plano ideal:** Cada plano foi cuidadosamente desenvolvido para atender diferentes necessidades e orçamentos.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [{ type: 3, custom_id: `subproduct_select_${paymentMethod}`, placeholder: 'Selecione seu plano', options }] }
        );

        // Botão de Showcase (link externo) por produto, se configurado
        if (product.showcase_url) {
            components.push({
                type: 1,
                components: [
                    { type: 2, style: 5, label: 'Ver Showcase', url: product.showcase_url }
                ]
            });
        }

        components.push({ type: 1, components: [{ type: 2, style: 2, label: '← Voltar aos Produtos', custom_id: `back_to_products_${paymentMethod}` }] });

        return {
            type: 17,
            components
        };
    }

    static buildCart(user, product, subproduct, paymentMethod, displayPrice, stockAvailable, pricingInfo, channelId, useBalance = false, userBalance = 0) {
        const finalPrice = pricingInfo.finalPrice;
        const balanceToUse = useBalance ? Math.min(userBalance, finalPrice) : 0;
        const remainingPrice = finalPrice - balanceToUse;
        
        const components = [
            { type: 10, content: `# Seu Carrinho Pessoal` },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: `> **Olá ${user.username}!** Seu carrinho está quase pronto. Revise os detalhes abaixo e finalize sua compra com segurança.` },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `** Produto:** ${product.titulo}\n** Plano:** ${subproduct.nome}\n** Preço:** ${displayPrice}\n** Pagamento:** ${Utils.getPaymentDisplay(paymentMethod)}\n** Estoque:** ${stockAvailable} unidades` }
        ];

        // Seção de saldo
        if (userBalance > 0) {
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `** Seu Saldo:** R$ ${userBalance.toFixed(2)}` }
            );

            if (useBalance) {
                if (balanceToUse >= finalPrice) {
                    components.push({ type: 10, content: `** Pagamento:** Será pago integralmente com saldo (R$ ${finalPrice.toFixed(2)})` });
                } else {
                    components.push({ type: 10, content: `**Pagamento Misto:**\n• Saldo: R$ ${balanceToUse.toFixed(2)}\n• ${Utils.getPaymentDisplay(paymentMethod)}: R$ ${remainingPrice.toFixed(2)}` });
                }
            } else {
                components.push({ type: 10, content: `**< Uso do saldo está desativado**` });
            }
        }

        if (pricingInfo.hasDiscounts) {
            const savings = pricingInfo.originalPrice - pricingInfo.finalPrice;
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: ` **Parabéns!** Você economizou **R$ ${savings.toFixed(2)}** com nossos descontos especiais!` }
            );
        }

        const selectOptions = [];
        
        if (stockAvailable > 0) {
            if (useBalance && balanceToUse >= finalPrice) {
                selectOptions.push({
                    label: 'Finalizar com Saldo',
                    value: `finalize_balance_${channelId}`,
                    description: 'Pagar integralmente com seu saldo'
                });
            } else if (!useBalance || remainingPrice > 0) {
                selectOptions.push({
                    label: 'Finalizar Compra',
                    value: `finalize_purchase_${channelId}`,
                    description: 'Prosseguir com o pagamento'
                });
            }
        } else {
            selectOptions.push({
                label: 'Produto Esgotado',
                value: `out_of_stock_${channelId}`,
                description: 'Este produto está temporariamente esgotado'
            });
        }

        if (userBalance > 0 && stockAvailable > 0) {
            const balanceLabel = useBalance ? 'Desativar Saldo' : 'Ativar Saldo';
            const balanceValue = useBalance ? `toggle_balance_${channelId}_disable` : `toggle_balance_${channelId}_enable`;
            const balanceDescription = useBalance ? 'Desativar uso do saldo' : 'Usar saldo para pagamento';
            
            selectOptions.push({
                label: balanceLabel,
                value: balanceValue,
                description: balanceDescription
            });
        }

        selectOptions.push({
            label: 'Cancelar Pedido',
            value: `cancel_order_${channelId}`,
            description: 'Cancelar e fechar carrinho'
        });

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [{
                type: 3,
                custom_id: `cart_actions_${channelId}`,
                placeholder: 'Selecione uma ação para continuar',
                options: selectOptions
            }] }
        );

        return { type: 17, components };
    }

    static buildPixInstructions(paymentData, qrFileName) {
        const components = [
            { type: 10, content: '# <:cartaocvv:1380666417036136479> Pagamento PIX' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Pagamento instantâneo e seguro!** Escaneie o QR Code com seu app bancário ou copie o código PIX abaixo. Sua compra será confirmada automaticamente.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [{ 
                type: 2, 
                style: 2, 
                label: 'Estamos Processando!', 
                custom_id: 'processing_payment',
                disabled: true
            }] }
        ];

        if (qrFileName) {
            components.splice(3, 0, {
                type: 12,
                items: [{ media: { url: `attachment://${qrFileName}` } }]
            });
        }

        return { type: 17, components };
    }

    static buildCustomPixPayment(valor, txid, description, qrFileName, expiresAt, pixCode = null, userMention = null) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 💰 Pagamento PIX Personalizado' }
        ];

        if (userMention) {
            components.push({ type: 10, content: `> **Pagamento gerado para ${userMention}**` });
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Pagamento instantâneo via PIX!** Escaneie o QR Code ou copie o código PIX abaixo. O pagamento será verificado automaticamente.' },
            { type: 14, divider: false, spacing: 1 }
        );

        if (qrFileName) {
            components.push({
                type: 12,
                items: [{ media: { url: `attachment://${qrFileName}` } }]
            });
        }

        components.push(
            { type: 10, content: `**💵 Valor:** R$ ${valor.toFixed(2)}\n**📋 Descrição:** ${description}\n**🆔 ID:** \`${txid}\`\n**⏰ Expira:** <t:${Math.floor(expiresAt / 1000)}:R>` }
        );

        if (pixCode) {
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `**📋 Código PIX Copia e Cola:**\n\`\`\`${pixCode}\`\`\`` }
            );
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '⚠️ **Importante:** O pagamento expira em 1 hora. Após a confirmação, o valor será creditado automaticamente.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [
                { 
                    type: 2, 
                    style: 3, 
                    label: 'Aguardando Pagamento', 
                    custom_id: 'custom_pix_pending',
                    disabled: true
                }
            ]}
        );

        return { type: 17, components };
    }

        static buildCustomPixConfirmed(userTag, valor, description, paymentId, efiTxid = null, key = null) {
        const components = [
            {
                type: 10,
                content: "# 💰 Suas Chaves - Root@Unk"
            },
            {
                type: 10,
                content: `> 🎉 Compra Finalizada! Suas chaves foram entregues com sucesso!\n\n👤 **Cliente:** ${userTag}\n💰 **Valor:** R$ ${valor.toFixed(2)}\n💳 **Método:** PIX\n🆔 **ID Interno:** \`${paymentId}\`${efiTxid ? `\n🆔 **ID EFI:** \`${efiTxid}\`` : ''}`
            }
        ];

        // Segundo componente com descrição e key
        const secondComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: `📋 **Descrição:** ${description}\n🔑 **Key Adquirida:**\n\`\`\`\n${key || 'KEY QUE O USUÁRIO RECEBEU'}\n\`\`\``
                }
            ]
        };

        // Terceiro componente com botões
        const thirdComponent = {
            type: 1,
            components: [
                {
                    type: 2,
                    style: 2,
                    label: "Valor:",
                    emoji: null,
                    disabled: false,
                    custom_id: "f792b207a70547b8dfa1b3737d822826"
                },
                {
                    type: 2,
                    style: 2,
                    label: "Data:",
                    emoji: null,
                    disabled: false,
                    custom_id: "a6c402fd41dc47e4a4b216b70162a776"
                }
            ]
        };

        return [components, secondComponent, thirdComponent];
    }

    static buildCryptoInstructions(paymentMethod, brlPrice, walletAddress, cryptoAmount) {
        return {
            type: 17,
            components: [
                { type: 10, content: `# 💰 Pagamento ${Utils.getPaymentDisplay(paymentMethod)}` },
                { type: 10, content: `**🔢 Valor Exato:** \`${cryptoAmount}\`\n**💵 Equivalente:** \`R$ ${brlPrice.toFixed(2)}\`\n\n**📬 Endereço da Carteira:**\n\`\`\`${walletAddress}\`\`\`` },
                { type: 10, content: '⚠️ **Importante:** Envie apenas o valor exato para o endereço correto. Entre em contato após realizar o pagamento!' }
            ]
        };
    }

    static buildKeyDelivery(productName, planName, price, paymentMethod, key, transactionId) {
        return {
            type: 17,
            components: [
                { type: 10, content: '#  Compra Realizada com Sucesso!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Parabéns!** Sua compra foi processada com sucesso. Abaixo estão os detalhes da sua transação e sua key de acesso.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**Produto:** **${productName} - ${planName}**\n** Valor Pago:** ${price}\n** Método:** ${Utils.getPaymentDisplay(paymentMethod)}\n** Transação:** ${transactionId}` },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `** Sua Key de Acesso:**\n\`${key}\`` },
                { type: 14, divider: true, spacing: 1 },
                // Botões de download
                { type: 1, components: [
                    { type: 2, style: 5, label: 'Baixar Produto', url: 'https://softwares.squareweb.app/' },
                    { type: 2, style: 5, label: 'Baixar Drivers', url: 'https://rootunk.xyz/drivers' },
                    { type: 2, style: 5, label: 'Tutorials', url: 'https://rootunk.xyz/tutoriais' }
                ] },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '-# <:maosbatendopalmas:1380666795467472947> **Obrigado por escolher a Root@Unk!** Mantenha sua key segura e aproveite nossos produtos premium!' }
            ]
        };
    }

    static buildBalanceAdded(userTag, amount, newBalance, adminTag) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# 💰 Saldo Adicionado!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Saldo creditado com sucesso!** O valor foi adicionado à conta do usuário e já está disponível para uso.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Usuário:** ${userTag}\n**➕ Valor Adicionado:** R$ ${amount.toFixed(2)}\n**💰 Novo Saldo:** R$ ${newBalance.toFixed(2)}\n**👨‍💼 Adicionado por:** ${adminTag}` }
            ]
        };
    }

    static buildBalanceInfo(userTag, balance) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# 💰 Consulta de Saldo' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Informações da conta atualizadas!** Confira abaixo o saldo atual disponível para compras.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Usuário:** ${userTag}\n**💰 Saldo Disponível:** R$ ${balance.toFixed(2)}\n\n${balance > 0 ? '✅ **Saldo suficiente para compras!**\n💡 **Dica:** Na loja, você pode usar o menu "💰 Ativar Saldo" para usar seu saldo como pagamento.' : '⚠️ **Saldo insuficiente. Entre em contato para adicionar créditos.**'}` }
            ]
        };
    }

    static buildMixedPaymentInstructions(balanceToUse, remainingBrlPrice, productName, planName, qrFileName, pixCode) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 💰 Pagamento Misto - Saldo + PIX' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Pagamento híbrido configurado!** Parte será debitada do seu saldo e o restante via PIX.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `**📦 Produto:** ${productName} - ${planName}\n**💰 Saldo Usado:** R$ ${balanceToUse.toFixed(2)}\n**💳 PIX Restante:** R$ ${remainingBrlPrice.toFixed(2)}\n\n🔄 **Próximos Passos:**\n1. Seu saldo será debitado automaticamente\n2. Pague o valor restante via PIX abaixo` }
        ];

        if (qrFileName) {
            components.push(
                { type: 14, divider: true, spacing: 1 },
                {
                    type: 12,
                    items: [{ media: { url: `attachment://${qrFileName}` } }]
                }
            );
        }

        if (pixCode) {
            components.push(
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📋 Código PIX (Valor Restante):**\n\`\`\`${pixCode}\`\`\`` }
            );
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '⚠️ **Importante:** Após o pagamento PIX, sua compra será processada automaticamente!' }
        );

        return { type: 17, components };
    }

    static buildBalancePaymentSuccess(user, product, subproduct, price, balanceUsed, remainingBalance) {
        return {
            type: 17,
            components: [
                { type: 10, content: '# ✅ Compra Finalizada com Saldo!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Pagamento processado com sucesso!** Sua compra foi paga integralmente com seu saldo disponível.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Cliente:** ${user.username}\n**📦 Produto:** ${product.titulo} - ${subproduct.nome}\n**💰 Valor Pago:** ${price}\n**💳 Saldo Usado:** R$ ${balanceUsed.toFixed(2)}\n**💰 Saldo Restante:** R$ ${remainingBalance.toFixed(2)}\n**🚀 Entrega:** ✅ Key enviada via DM` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '🎉 **Obrigado por sua compra!** Verifique suas mensagens diretas para receber sua key.' }
            ]
        };
    }

    static buildStockInterface() {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# 📦 Gerenciamento de Estoque' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Central de gerenciamento completo do estoque.** Adicione, remova ou monitore keys de todos os seus produtos.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: '**Opções disponíveis:**\n• ➕ **Adicionar estoque:** Inserir novas keys\n• ➖ **Remover estoque:** Retirar keys específicas\n• 📊 **Monitorar estoque:** Ver status de todos produtos\n• 🚨 **Alertas automáticos:** Notificações quando estoque fica baixo' },
                { type: 14, divider: false, spacing: 1 },
                { type: 1, components: [{ type: 3, custom_id: 'stock_action_select', placeholder: '🎯 Escolha uma ação de gerenciamento', options: [
                    { label: '➕ Adicionar Estoque', value: 'add_stock', description: 'Adicionar keys a um produto', emoji: { name: '➕' } },
                    { label: '➖ Remover Estoque', value: 'remove_stock', description: 'Remover keys de um produto', emoji: { name: '➖' } },
                    { label: '📊 Monitorar Estoque', value: 'monitor_stock', description: 'Ver status geral do estoque', emoji: { name: '📊' } },
                    { label: '🔍 Verificar Produto', value: 'check_product', description: 'Verificar estoque de produto específico', emoji: { name: '🔍' } },
                    { label: '⚙️ Configurar Alertas', value: 'configure_alerts', description: 'Ajustar limites de estoque baixo', emoji: { name: '⚙️' } }
                ]}] }
            ]
        };
    }

    static buildRemoveStockInterface() {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# ➖ Remover Estoque' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Remoção controlada de estoque.** Selecione um produto para remover keys específicas do estoque.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: '**⚠️ Importante:**\n• A remoção é permanente e irreversível\n• Keys removidas não poderão ser recuperadas\n• Use com cuidado para evitar perda de inventory' },
                { type: 14, divider: false, spacing: 1 },
                { type: 1, components: [{ type: 3, custom_id: 'remove_stock_product_select', placeholder: 'Selecione um produto para remover estoque', options: [] }] },
                { type: 1, components: [{ type: 2, style: 2, label: '← Voltar ao Menu Principal', custom_id: 'back_to_stock_menu' }] }
            ]
        };
    }

    static buildRemoveStockProductInterface(product, productId, options) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: `# ➖ Remover Estoque - ${product.titulo}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `> **Produto:** ${product.titulo}\n> **ID:** \`${productId}\`` },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: '**Selecione o plano** para remover keys do estoque. Você poderá escolher quantas keys remover na próxima etapa.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 1, components: [{ type: 3, custom_id: `remove_stock_subproduct_select`, placeholder: 'Escolha o plano para remover estoque', options }] },
                { type: 1, components: [
                    { type: 2, style: 2, label: '← Voltar aos Produtos', custom_id: 'back_to_remove_stock_products' },
                    { type: 2, style: 2, label: '🏠 Menu Principal', custom_id: 'back_to_stock_menu' }
                ]}
            ]
        };
    }

    static buildStockRemoved(productTitle, subproductName, keysRemoved, remainingStock, removedKeys) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# ✅ Estoque Removido!' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Keys removidas com sucesso!** O estoque foi atualizado e as keys foram retiradas permanentemente.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `**📦 Produto:** ${productTitle}\n**🏷️ Plano:** ${subproductName}\n**➖ Keys Removidas:** ${keysRemoved}\n**📊 Estoque Restante:** ${remainingStock}\n**🎯 Status:** ${remainingStock > 0 ? 'Disponível para venda' : '⚠️ ESGOTADO'}` }
        ];

        // Mostrar as keys removidas se não forem muitas
        if (removedKeys && removedKeys.length <= 3) {
            const keysList = removedKeys.map(key => `\`${key}\``).join('\n');
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `**🔑 Keys Removidas:**\n${keysList}` }
            );
        }

        if (remainingStock === 0) {
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '🚨 **ATENÇÃO:** Este produto ficou sem estoque e não está mais disponível para venda!' }
            );
        } else if (remainingStock <= 3) {
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `⚠️ **AVISO:** Estoque baixo! Restam apenas ${remainingStock} keys.` }
            );
        }

        return { type: 17, components };
    }

    static buildStockMonitor(stockSummary) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 📊 Monitor de Estoque' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Visão geral em tempo real do estoque.** Acompanhe o status de todos os produtos e identifique alertas críticos.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (Object.keys(stockSummary).length === 0) {
            components.push({ type: 10, content: '📭 **Nenhum produto com estoque encontrado.**\n\n💡 **Dica:** Use "➕ Adicionar Estoque" para começar a popular seu inventory.' });
        } else {
            let totalProducts = 0;
            let totalStock = 0;
            let alertCount = 0;
            let outOfStockCount = 0;

            let stockText = '**📋 Resumo por Produto:**\n\n';
            
            for (const [productId, data] of Object.entries(stockSummary)) {
                totalProducts++;
                let productTotal = 0;
                let productAlerts = 0;
                
                stockText += `**📦 ${data.title}**\n`;
                
                for (const [subIndex, subData] of Object.entries(data.subproducts)) {
                    productTotal += subData.available;
                    
                    let statusIcon = '✅';
                    if (subData.available === 0) {
                        statusIcon = '❌';
                        outOfStockCount++;
                    } else if (subData.available <= 3) {
                        statusIcon = '⚠️';
                        alertCount++;
                        productAlerts++;
                    }
                    
                    stockText += `   ${statusIcon} ${subData.name}: ${subData.available} keys\n`;
                }
                
                totalStock += productTotal;
                stockText += `   📊 **Total:** ${productTotal} keys${productAlerts > 0 ? ' ⚠️' : ''}\n\n`;
            }
            
            // Estatísticas gerais
            const statsText = `**📈 Estatísticas Gerais:**\n• **Total de produtos:** ${totalProducts}\n• **Total de keys:** ${totalStock}\n• **Produtos com alertas:** ${alertCount}\n• **Produtos esgotados:** ${outOfStockCount}\n\n`;
            
            components.push({ type: 10, content: statsText + stockText });
            
            // Alertas críticos
            if (alertCount > 0 || outOfStockCount > 0) {
                let alertText = '🚨 **Alertas Críticos:**\n';
                if (outOfStockCount > 0) {
                    alertText += `• ${outOfStockCount} produto(s) esgotado(s)\n`;
                }
                if (alertCount > 0) {
                    alertText += `• ${alertCount} produto(s) com estoque baixo\n`;
                }
                
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: alertText }
                );
            }
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 1, label: '🔄 Atualizar', custom_id: 'refresh_stock_monitor' },
                { type: 2, style: 2, label: '← Voltar ao Menu', custom_id: 'back_to_stock_menu' }
            ]}
        );

        return { type: 17, components };
    }

    static buildStockProductInterface(product, productId, options) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: `# 📦 Estoque - ${product.titulo}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `> **Produto:** ${product.titulo}\n> **ID:** \`${productId}\`` },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: '**Selecione o plano** para adicionar keys ao estoque. As keys serão consumidas automaticamente quando houver vendas.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 1, components: [{ type: 3, custom_id: `stock_subproduct_select`, placeholder: 'Escolha o plano para adicionar estoque', options }] },
                { type: 1, components: [{ type: 2, style: 2, label: '← Voltar aos Produtos', custom_id: 'back_to_stock_products' }] }
            ]
        };
    }

    static buildStockAdded(productTitle, subproductName, keysAdded, totalStock) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# ✅ Estoque Adicionado!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Keys adicionadas com sucesso!** O estoque foi atualizado e as keys estão prontas para serem vendidas automaticamente.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📦 Produto:** ${productTitle}\n**🏷️ Plano:** ${subproductName}\n**➕ Keys Adicionadas:** ${keysAdded}\n**📊 Total no Estoque:** ${totalStock}\n**🎯 Status:** Disponível para venda` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '💡 **Dica:** Use `/checkstock` para verificar o estoque completo de todos os produtos.' }
            ]
        };
    }

    static buildStockInfo(productId, product, stock) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 📦 Informações de Estoque' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: `> **Produto:** ${product.titulo}\n> **ID:** \`${productId}\`` },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (product.subprodutos && product.subprodutos.length > 0) {
            let stockInfo = '**📊 Estoque por Plano:**\n\n';
            
            for (let i = 0; i < product.subprodutos.length; i++) {
                const sub = product.subprodutos[i];
                const subStock = stock[productId]?.[i] || [];
                const available = subStock.length;
                
                stockInfo += `**${sub.nome}**\n`;
                stockInfo += `• Disponível: ${available} keys\n`;
                stockInfo += `• Preço: R$ ${sub.preco.toFixed(2)}\n`;
                stockInfo += `• Status: ${available > 0 ? '✅ Em estoque' : '❌ Esgotado'}\n\n`;
            }
            
            components.push({ type: 10, content: stockInfo });
            
            // Adicionar botão para adicionar estoque
            components.push(
                { type: 14, divider: true, spacing: 1 },
                { type: 1, components: [
                    { type: 2, style: 1, label: '📦 Adicionar Estoque', custom_id: `add_stock_to_${productId}` }
                ]}
            );
        } else {
            components.push({ type: 10, content: '⚠️ **Produto sem planos configurados**' });
        }

        return { type: 17, components };
    }

    // ===== NOVOS COMPONENTES PARA ESTATÍSTICAS =====
    static buildStatsDashboard(summary) {
        return {
            type: 17,
            components: [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: '# 📊 Dashboard de Vendas' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Visão geral completa do desempenho da loja.** Acompanhe todas as métricas importantes em tempo real.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**💰 Receita Total:** R$ ${summary.totalRevenue.toFixed(2)}\n**🛍️ Total de Vendas:** ${summary.totalSales}\n**👥 Total de Clientes:** ${summary.totalCustomers}\n**📈 Ticket Médio:** R$ ${summary.averageOrderValue.toFixed(2)}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `**📅 Hoje:**\n• Vendas: ${summary.todaySales}\n• Receita: R$ ${summary.todayRevenue.toFixed(2)}\n• Clientes únicos: ${summary.todayCustomers}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `**📊 Insights:**\n• Crescimento mensal: ${summary.monthlyGrowth > 0 ? '+' : ''}${summary.monthlyGrowth.toFixed(1)}%\n• Método favorito: ${summary.topPaymentMethod}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 1, components: [
                    { type: 3, custom_id: 'stats_category', placeholder: '📊 Escolha uma categoria para ver detalhes', options: [
                        { label: '🏆 Top Produtos', value: 'top_products', description: 'Produtos mais vendidos', emoji: { name: '🏆' } },
                        { label: '👑 Top Clientes', value: 'top_customers', description: 'Clientes que mais compraram', emoji: { name: '👑' } },
                        { label: '📈 Vendas Diárias', value: 'daily_sales', description: 'Gráfico dos últimos 30 dias', emoji: { name: '📈' } },
                        { label: '💳 Métodos de Pagamento', value: 'payment_methods', description: 'Estatísticas por método', emoji: { name: '💳' } },
                        { label: '📅 Receita Mensal', value: 'monthly_revenue', description: 'Evolução mensal da receita', emoji: { name: '📅' } }
                    ]}
                ] }
            ]
        };
    }

    static buildTopProducts(topProducts) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 🏆 Top Produtos Mais Vendidos' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Ranking dos produtos com melhor desempenho.** Baseado na receita total gerada por cada produto.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (topProducts.length === 0) {
            components.push({ type: 10, content: '📭 **Nenhuma venda registrada ainda.**' });
        } else {
            let ranking = '**🎯 Ranking por Receita:**\n\n';
            
            for (let i = 0; i < Math.min(topProducts.length, 10); i++) {
                const product = topProducts[i];
                const position = i + 1;
                const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}º`;
                
                ranking += `${medal} **${product.product}**\n`;
                ranking += `   💰 R$ ${product.revenue.toFixed(2)} • 🛍️ ${product.sales} vendas\n`;
                ranking += `   📊 Ticket médio: R$ ${(product.revenue / product.sales).toFixed(2)}\n\n`;
            }
            
            components.push({ type: 10, content: ranking });
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 2, label: '← Voltar ao Dashboard', custom_id: 'back_to_dashboard' }
            ]}
        );

        return { type: 17, components };
    }

    static buildTopCustomers(topCustomers) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 👑 Top Clientes VIP' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Nossos clientes mais valiosos.** Ranking baseado no valor total gasto na loja.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (topCustomers.length === 0) {
            components.push({ type: 10, content: '📭 **Nenhum cliente registrado ainda.**' });
        } else {
            let ranking = '**👑 Hall da Fama dos Clientes:**\n\n';
            
            for (let i = 0; i < Math.min(topCustomers.length, 10); i++) {
                const customer = topCustomers[i];
                const position = i + 1;
                const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}º`;
                
                ranking += `${medal} **${customer.username}**\n`;
                ranking += `   💎 Total gasto: R$ ${customer.totalSpent.toFixed(2)}\n`;
                ranking += `   🛍️ Compras: ${customer.totalPurchases}\n`;
                ranking += `   📊 Ticket médio: R$ ${(customer.totalSpent / customer.totalPurchases).toFixed(2)}\n\n`;
            }
            
            components.push({ type: 10, content: ranking });
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 2, label: '← Voltar ao Dashboard', custom_id: 'back_to_dashboard' }
            ]}
        );

        return { type: 17, components };
    }

    static buildDailySales(dailyStats) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 📈 Vendas Diárias - Últimos 30 Dias' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Evolução das vendas nos últimos 30 dias.** Acompanhe o desempenho diário da sua loja.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (dailyStats.length === 0) {
            components.push({ type: 10, content: '📭 **Nenhuma venda registrada no período.**' });
        } else {
            // Estatísticas do período
            const totalSales = dailyStats.reduce((sum, day) => sum + day.sales, 0);
            const totalRevenue = dailyStats.reduce((sum, day) => sum + day.revenue, 0);
            const avgSalesPerDay = totalSales / dailyStats.length;
            const avgRevenuePerDay = totalRevenue / dailyStats.length;
            const bestDay = dailyStats.reduce((best, day) => day.revenue > best.revenue ? day : best, dailyStats[0]);

            components.push(
                { type: 10, content: `**📊 Resumo do Período (30 dias):**\n• Total de vendas: ${totalSales}\n• Receita total: R$ ${totalRevenue.toFixed(2)}\n• Média diária: ${avgSalesPerDay.toFixed(1)} vendas\n• Receita média diária: R$ ${avgRevenuePerDay.toFixed(2)}\n• Melhor dia: ${bestDay.date} (R$ ${bestDay.revenue.toFixed(2)})` },
                { type: 14, divider: true, spacing: 1 }
            );

            // Gráfico simples em texto dos últimos 7 dias
            const last7Days = dailyStats.slice(-7);
            let chart = '**📈 Últimos 7 Dias (Receita):**\n```\n';
            
            const maxRevenue = Math.max(...last7Days.map(d => d.revenue));
            
            for (const day of last7Days) {
                const date = new Date(day.date).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
                const barLength = maxRevenue > 0 ? Math.round((day.revenue / maxRevenue) * 20) : 0;
                const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
                chart += `${date} ${bar} R$ ${day.revenue.toFixed(2)}\n`;
            }
            chart += '```';
            
            components.push({ type: 10, content: chart });
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 2, label: '← Voltar ao Dashboard', custom_id: 'back_to_dashboard' }
            ]}
        );

        return { type: 17, components };
    }

    static buildPaymentMethodStats(paymentStats) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 💳 Estatísticas por Método de Pagamento' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Performance de cada método de pagamento.** Veja qual forma de pagamento seus clientes preferem.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (paymentStats.length === 0) {
            components.push({ type: 10, content: '📭 **Nenhuma venda registrada ainda.**' });
        } else {
            const totalRevenue = paymentStats.reduce((sum, method) => sum + method.revenue, 0);
            let methodsInfo = '**💳 Ranking por Método:**\n\n';
            
            for (let i = 0; i < paymentStats.length; i++) {
                const method = paymentStats[i];
                const percentage = totalRevenue > 0 ? (method.revenue / totalRevenue * 100) : 0;
                const methodIcon = method.method === 'pix' ? '💳' : 
                                 method.method === 'bitcoin' ? '₿' : 
                                 method.method === 'litecoin' ? 'Ł' : 
                                 method.method === 'balance' ? '💰' : 
                                 method.method === 'mixed' ? '🔄' : '💸';
                
                methodsInfo += `${methodIcon} **${Utils.getPaymentDisplay(method.method)}**\n`;
                methodsInfo += `   📊 ${percentage.toFixed(1)}% do total\n`;
                methodsInfo += `   💰 R$ ${method.revenue.toFixed(2)} • 🛍️ ${method.sales} vendas\n`;
                methodsInfo += `   📈 Ticket médio: R$ ${(method.revenue / method.sales).toFixed(2)}\n\n`;
            }
            
            components.push({ type: 10, content: methodsInfo });
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 2, label: '← Voltar ao Dashboard', custom_id: 'back_to_dashboard' }
            ]}
        );

        return { type: 17, components };
    }

    static buildMonthlyRevenue(monthlyStats) {
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 📅 Evolução da Receita Mensal' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Acompanhe o crescimento mês a mês.** Visualize a evolução da receita e identifique tendências.' },
            { type: 14, divider: false, spacing: 1 }
        ];

        if (monthlyStats.length === 0) {
            components.push({ type: 10, content: '📭 **Nenhuma venda registrada ainda.**' });
        } else {
            let monthlyInfo = '**📊 Evolução Mensal:**\n\n';
            
            // Pegar os últimos 6 meses
            const lastMonths = monthlyStats.slice(-6);
            
            for (let i = 0; i < lastMonths.length; i++) {
                const month = lastMonths[i];
                const [year, monthNum] = month.month.split('-');
                const monthName = new Date(year, monthNum - 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
                
                // Calcular crescimento em relação ao mês anterior
                let growth = '';
                if (i > 0) {
                    const prevRevenue = lastMonths[i - 1].revenue;
                    const growthPercent = prevRevenue > 0 ? ((month.revenue - prevRevenue) / prevRevenue * 100) : 0;
                    const growthIcon = growthPercent > 0 ? '📈' : growthPercent < 0 ? '📉' : '➡️';
                    growth = ` ${growthIcon} ${growthPercent > 0 ? '+' : ''}${growthPercent.toFixed(1)}%`;
                }
                
                monthlyInfo += `**${monthName}**\n`;
                monthlyInfo += `   💰 R$ ${month.revenue.toFixed(2)} • 🛍️ ${month.sales} vendas${growth}\n`;
                monthlyInfo += `   📈 Ticket médio: R$ ${(month.revenue / month.sales).toFixed(2)}\n\n`;
            }
            
            components.push({ type: 10, content: monthlyInfo });
            
            // Gráfico simples dos últimos 6 meses
            if (lastMonths.length > 1) {
                const maxRevenue = Math.max(...lastMonths.map(m => m.revenue));
                let chart = '**📊 Gráfico de Tendência:**\n```\n';
                
                for (const month of lastMonths) {
                    const [year, monthNum] = month.month.split('-');
                    const shortMonth = new Date(year, monthNum - 1).toLocaleDateString('pt-BR', { month: 'short' });
                    const barLength = maxRevenue > 0 ? Math.round((month.revenue / maxRevenue) * 15) : 0;
                    const bar = '█'.repeat(barLength) + '░'.repeat(15 - barLength);
                    chart += `${shortMonth} ${bar} R$ ${month.revenue.toFixed(0)}\n`;
                }
                chart += '```';
                
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: chart }
                );
            }
        }

        components.push(
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 2, label: '← Voltar ao Dashboard', custom_id: 'back_to_dashboard' }
            ]}
        );

        return { type: 17, components };
    }

    static buildGiveaway(giveaway, ended = false) {
        if (ended) {
            // Embed de sorteio encerrado
            const firstEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 9,
                        accessory: {
                            type: 2,
                            style: 5,
                            label: "Nosso site!",
                            emoji: null,
                            disabled: false,
                            url: "https://rootunk.store"
                        },
                        components: [
                            {
                                type: 10,
                                content: "# GRANDE SORTEIO — ROOT@UNK "
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: `📦 Prêmio: ${giveaway.prize}\n🏆 Número de Ganhadores: ${giveaway.winnerCount}\n⏰ Duração: Encerrado`
                    }
                ]
            };

            const secondEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 10,
                        content: `🏆 **SORTEIO ENCERRADO!**\n\n${giveaway.winners.length > 0 ? 
                            `**🎉 Vencedores:**\n${giveaway.winners.map((winner, index) => `${index + 1}. <@${winner.userId}>`).join('\n')}` : 
                            'Nenhum participante no sorteio.'}\n\n**📊 Total de participantes:** ${giveaway.participants.length}`
                    }
                ]
            };

            return [firstEmbed, secondEmbed];
        } else {
            // Embed de sorteio ativo
            const firstEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 9,
                        accessory: {
                            type: 2,
                            style: 5,
                            label: "Nosso site!",
                            emoji: null,
                            disabled: false,
                            url: "https://rootunk.store"
                        },
                        components: [
                            {
                                type: 10,
                                content: "# GRANDE SORTEIO — ROOT@UNK "
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: `📦 Prêmio: ${giveaway.prize}\n🏆 Número de Ganhadores: ${giveaway.winnerCount}\n⏰ Duração: <t:${Math.floor(giveaway.endTime/1000)}:R>\n👥 Participantes: ${giveaway.participants.length}`
                    }
                ]
            };

            const secondEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 10,
                        content: `🔔 **Como participar:**\nClique no botão 🎉 abaixo para participar do sorteio.\n\n-# O vencedor receberá a key automaticamente via ticket.\n-# Caso não resgate no prazo informado, o prêmio poderá ser repassado a outro participante.\n-# 🍀 Boa sorte a todos os participantes!`
                    },
                    {
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 3,
                                label: "🎉 Participar do Sorteio",
                                emoji: null,
                                disabled: false,
                                custom_id: `giveaway_join_${giveaway.id}`
                            }
                        ]
                    }
                ]
            };

            return [firstEmbed, secondEmbed];
        }
    }



    static buildProductDetailEmbed(product, subproductOptions) {
        const containerComponents = [];
        
        // 1. Imagem do produto (se existir)
        if (product.imagem) {
            containerComponents.push({
                type: 12,
                items: [
                    {
                        media: {
                            url: product.imagem
                        },
                        description: null,
                        spoiler: false
                    }
                ]
            });
        }
        
        // 2. Informações do produto (se existir)
        if (product.informacoes && product.informacoes.trim()) {
            containerComponents.push({
                type: 10,
                content: product.informacoes
            });
        }
        
        // 3. Divider
        containerComponents.push({
            type: 14,
            divider: true,
            spacing: 1
        });
        
        // 4. Descrição do produto - dividida em partes se for muito longa
        const maxLength = 2000; // Limite seguro para cada parte
        const descricao = product.descricao || '';
        
        if (descricao.length > maxLength) {
            // Dividir a descrição em partes menores
            let remainingDesc = descricao;
            let partNumber = 1;
            
            while (remainingDesc.length > 0) {
                let part = remainingDesc.substring(0, maxLength);
                
                // Se não for o último caractere, tentar quebrar em uma linha completa
                if (remainingDesc.length > maxLength) {
                    const lastNewline = part.lastIndexOf('\n');
                    if (lastNewline > maxLength * 0.8) { // Se encontrar quebra de linha em 80% do texto
                        part = remainingDesc.substring(0, lastNewline);
                    }
                }
                
                containerComponents.push({
                    type: 10,
                    content: part
                });
                
                remainingDesc = remainingDesc.substring(part.length);
                partNumber++;
                
                // Adicionar divider entre partes (exceto na última)
                if (remainingDesc.length > 0) {
                    containerComponents.push({
                        type: 14,
                        divider: false,
                        spacing: 1
                    });
                }
            }
        } else {
            // Descrição cabe em uma parte
            containerComponents.push({
                type: 10,
                content: descricao
            });
        }
        
        // 5. Divider
        containerComponents.push({
            type: 14,
            divider: true,
            spacing: 1
        });
        
        // 6. Select de planos
        console.log('🔧 Construindo select com product.id:', product.id);
        containerComponents.push({
            type: 1,
            components: [
                {
                    type: 3,
                    custom_id: `embed_subproduct_select_${product.id}`,
                    placeholder: 'Selecione um plano para comprar',
                    options: subproductOptions
                }
            ]
        });
        
        const components = [{
            type: 17,
            accent_color: null,
            spoiler: false,
            components: containerComponents
        }];
        
        // 7. Botão do site (se existir) - fora da embed
        if (product.site_url) {
            components.push({
                type: 1,
                components: [
                    {
                        type: 2,
                        style: 5,
                        label: product.site_label || "nosso site",
                        emoji: null,
                        disabled: false,
                        url: product.site_url
                    }
                ]
            });
        }
        
        return components;
    }

    static buildEditProductSelect(productOptions) {
        return {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: "# ✏️ Editor de Produtos"
                },
                {
                    type: 10,
                    content: "Selecione o produto que deseja editar:"
                },
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: 'edit_product_select',
                            placeholder: 'Escolha um produto para editar',
                            options: productOptions
                        }
                    ]
                }
            ]
        };
    }

    static buildSetEmbedSelect(productOptions) {
        return {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: "# 🛒 Criar Embed de Produto"
                },
                {
                    type: 10,
                    content: "Selecione o produto para criar a embed:"
                },
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: 'set_embed_select',
                            placeholder: 'Escolha um produto para criar embed',
                            options: productOptions
                        }
                    ]
                }
            ]
        };
    }
}

// ===== UTILS =====
const Utils = {
    async ensureDataDir() {
        const dataDir = path.join(__dirname, 'data');
        const tempDir = path.join(__dirname, 'temp');
        try {
            await fs.mkdir(dataDir, { recursive: true });
            await fs.mkdir(tempDir, { recursive: true });
        } catch (error) {
            console.error('Erro criando diretórios:', error);
        }
    },

    async loadJSON(filePath, defaultValue = {}) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveJSON(filePath, defaultValue);
                return defaultValue;
            }
            return defaultValue;
        }
    },

    async saveJSON(filePath, data) {
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error(`Erro salvando ${filePath}:`, error);
        }
    },

    generateKey() {
        return Array(32).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    },

    generateTransactionId() {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substr(2, 5);
        return `TXN-${timestamp}-${random}`.toUpperCase();
    },

    parseDuration(durationStr) {
        const match = durationStr.match(/^(\d+)([dhms])$/);
        if (!match) {
            throw new Error('Formato de duração inválido. Use: 1d, 2h, 30m, 45s');
        }
        
        const value = parseInt(match[1]);
        const unit = match[2];
        
        const multipliers = {
            'd': 24 * 60 * 60 * 1000, // dias
            'h': 60 * 60 * 1000,      // horas
            'm': 60 * 1000,           // minutos
            's': 1000                 // segundos
        };
        
        return value * multipliers[unit];
    },

    getPaymentDisplay(method) {
        const methods = { 
            bitcoin: 'Bitcoin', 
            litecoin: 'Litecoin', 
            pix: 'PIX',
            balance: 'Saldo',
            mixed: 'Misto (Saldo + PIX)'
        };
        return methods[method] || method.toUpperCase();
    },

    calculateCryptoPrice(brlAmount, method) {
        const rate = CONFIG.CRYPTO_PRICES[method];
        if (!rate) return `R$ ${brlAmount.toFixed(2)}`;
        const cryptoAmount = (brlAmount / rate).toFixed(8);
        const symbols = { bitcoin: 'BTC', litecoin: 'LTC' };
        return `${cryptoAmount} ${symbols[method]}`;
    },

    getWalletAddress(method) {
        const addresses = {
            bitcoin: process.env.BITCOIN_ADDRESS || 'bc1qexample...',
            litecoin: process.env.LITECOIN_ADDRESS || 'ltc1qexample...'
        };
        return addresses[method] || 'Contact support';
    },

    async safeReply(interaction, options) {
        try {
            // Verificar se a interação ainda é válida
            if (!interaction || !interaction.isRepliable()) {
                console.log('⚠️ Interação não é respondível ou expirou');
                return null;
            }

            if (interaction.replied || interaction.deferred) {
                return await interaction.editReply(options);
            } else {
                const defaultOptions = { 
                    ...options, 
                    flags: options.flags !== undefined ? options.flags : 64,
                    ephemeral: options.ephemeral !== undefined ? options.ephemeral : true
                };
                return await interaction.reply(defaultOptions);
            }
        } catch (error) {
            console.error('Erro ao responder interação:', error);
            
            // Se for erro de interação expirada, apenas logar
            if (error.code === 10062) {
                console.log('⚠️ Interação expirada durante resposta');
                return null;
            }
            
            return null;
        }
    },

    checkRateLimit(userId) {
        const now = Date.now();
        const userInteractions = activeInteractions.get(userId) || [];
        
        // Limpar interações antigas (mais de 10 segundos)
        const validInteractions = userInteractions.filter(time => now - time < 10000);
        
        if (validInteractions.length >= CONFIG.MAX_INTERACTIONS_PER_USER) {
            return false;
        }
        
        validInteractions.push(now);
        activeInteractions.set(userId, validInteractions);
        
        // Limpar dados antigos periodicamente
        if (Math.random() < 0.1) { // 10% de chance de limpar
            this.cleanupOldInteractions();
        }
        
        return true;
    },

    cleanupOldInteractions() {
        const now = Date.now();
        for (const [userId, interactions] of activeInteractions.entries()) {
            const validInteractions = interactions.filter(time => now - time < 10000);
            if (validInteractions.length === 0) {
                activeInteractions.delete(userId);
            } else {
                activeInteractions.set(userId, validInteractions);
            }
        }
    },

    async cleanupTempFile(filePath, delay = 300000) {
        tempFiles.add(filePath);
        setTimeout(async () => {
            try {
                if (fsSync.existsSync(filePath)) {
                    await fs.unlink(filePath);
                    tempFiles.delete(filePath);
                }
            } catch (error) {
                console.error('Erro removendo arquivo temporário:', error);
            }
        }, delay);
    }
};

// ===== GLOBAL DISCOUNT =====
const GlobalDiscount = {
    async load() { 
        return await Utils.loadJSON(CONFIG.GLOBAL_DISCOUNT_FILE, { active: false, percentage: 0, createdBy: null, createdAt: null }); 
    },
    
    async save(data) { 
        await Utils.saveJSON(CONFIG.GLOBAL_DISCOUNT_FILE, data); 
    },

    async set(percentage, userId) {
        if (percentage < 0 || percentage > 100) {
            throw new Error('Porcentagem deve estar entre 0 e 100');
        }
        
        const discountData = {
            active: percentage > 0,
            percentage: percentage / 100,
            createdBy: userId,
            createdAt: new Date().toISOString(),
            lastModified: new Date().toISOString()
        };
        
        await this.save(discountData);
        console.log(`✅ Desconto global ${percentage > 0 ? 'ativado' : 'desativado'}: ${percentage}%`);
        return discountData;
    },

    async remove(userId) {
        const discountData = { active: false, percentage: 0, removedBy: userId, removedAt: new Date().toISOString() };
        await this.save(discountData);
        console.log('✅ Desconto global removido');
        return discountData;
    },

    async isActive() {
        const data = await this.load();
        return data.active && data.percentage > 0;
    },

    async getPercentage() {
        const data = await this.load();
        return data.active ? data.percentage : 0;
    },

    async getInfo() {
        return await this.load();
    },

    async applyDiscount(price, userId = null) {
        const data = await this.load();
        if (!data.active || data.percentage <= 0) return price;
        const discounted = price * (1 - data.percentage);
        console.log(`💰 Desconto global aplicado: R$ ${price.toFixed(2)} → R$ ${discounted.toFixed(2)} (${(data.percentage * 100).toFixed(0)}% OFF)`);
        return discounted;
    }
};

// ===== PRICING SYSTEM =====
const PricingSystem = {
    async calculateFinalPrice(basePrice, userId) {
        let finalPrice = basePrice;
        const discounts = [];
        
        const isReseller = await Resellers.isReseller(userId);
        
        if (isReseller) {
            // Resellers recebem apenas desconto de reseller
            finalPrice = await Resellers.applyDiscount(finalPrice, userId);
            discounts.push({
                type: 'reseller',
                percentage: (CONFIG.RESELLER_DISCOUNT * 100).toFixed(0) + '%',
                description: `Desconto Reseller (${(CONFIG.RESELLER_DISCOUNT * 100).toFixed(0)}% OFF)`
            });
        } else {
            // Não-resellers recebem apenas desconto global (se ativo)
            const globalDiscountActive = await GlobalDiscount.isActive();
            if (globalDiscountActive) {
                const globalPercentage = await GlobalDiscount.getPercentage();
                finalPrice = await GlobalDiscount.applyDiscount(finalPrice, userId);
                discounts.push({
                    type: 'global',
                    percentage: (globalPercentage * 100).toFixed(0) + '%',
                    description: `Desconto Global (${(globalPercentage * 100).toFixed(0)}% OFF)`
                });
            }
        }
        
        return {
            originalPrice: basePrice,
            finalPrice,
            totalSavings: basePrice - finalPrice,
            discounts,
            hasDiscounts: discounts.length > 0
        };
    },

    formatPriceDisplay(pricingInfo) {
        const { originalPrice, finalPrice, discounts, hasDiscounts } = pricingInfo;
        
        if (!hasDiscounts) {
            return `R$ ${finalPrice.toFixed(2)}`;
        }
        
        const savings = originalPrice - finalPrice;
        const savingsPercent = ((savings / originalPrice) * 100).toFixed(0);
        
        const finalPriceStr = `R$ ${finalPrice.toFixed(2)}`;
        const originalPriceStr = `R$ ${originalPrice.toFixed(2)}`;
        
        return `~~${originalPriceStr}~~ **${finalPriceStr}** (${savingsPercent}% OFF)`;
    }
};

// ===== RESELLERS =====
const Resellers = {
    async load() { return await Utils.loadJSON(CONFIG.RESELLERS_FILE); },
    async save(data) { await Utils.saveJSON(CONFIG.RESELLERS_FILE, data); },

    async add(userId) {
        const resellers = await this.load();
        resellers[userId] = {
            addedAt: new Date().toISOString(),
            discount: CONFIG.RESELLER_DISCOUNT,
            totalSales: 0,
            totalEarnings: 0
        };
        await this.save(resellers);
        console.log(`✅ Reseller adicionado: ${userId}`);
    },

    async remove(userId) {
        const resellers = await this.load();
        delete resellers[userId];
        await this.save(resellers);
        console.log(`❌ Reseller removido: ${userId}`);
    },

    async isReseller(userId) {
        const resellers = await this.load();
        return !!resellers[userId];
    },

    async applyDiscount(price, userId) {
        if (!(await this.isReseller(userId))) return price;
        const discounted = price * (1 - CONFIG.RESELLER_DISCOUNT);
        console.log(`💰 Desconto reseller aplicado: R$ ${price.toFixed(2)} → R$ ${discounted.toFixed(2)}`);
        return discounted;
    },

    async updateStats(userId, saleAmount) {
        const resellers = await this.load();
        if (resellers[userId]) {
            resellers[userId].totalSales++;
            resellers[userId].totalEarnings += saleAmount;
            await this.save(resellers);
        }
    }
};

// ===== PRODUCTS =====
const Products = {
    async load() { return await Utils.loadJSON(CONFIG.PRODUCTS_FILE); },
    async save(data) { await Utils.saveJSON(CONFIG.PRODUCTS_FILE, data); },

    async create(title, description, subproducts) {
        const products = await this.load();
        const id = `product_${Date.now()}`;
        
        products[id] = {
            titulo: title,
            descricao: description,
            subprodutos: subproducts,
            created_at: new Date().toISOString(),
            sales_count: 0,
            total_revenue: 0
        };
        
        await this.save(products);
        console.log(`✅ Produto criado: ${title} (${id})`);
        return id;
    },

    async updateSalesStats(productId, revenue) {
        const products = await this.load();
        if (products[productId]) {
            products[productId].sales_count++;
            products[productId].total_revenue += revenue;
            await this.save(products);
        }
    }
};

// ===== STOCK SYSTEM =====
const StockSystem = {
    async load() { 
        return await Utils.loadJSON(CONFIG.STOCK_FILE, {}); 
    },
    
    async save(data) { 
        await Utils.saveJSON(CONFIG.STOCK_FILE, data); 
    },

    async addStock(productId, subproductIndex, keys) {
        const stock = await this.load();
        
        if (!stock[productId]) {
            stock[productId] = {};
        }
        
        if (!stock[productId][subproductIndex]) {
            stock[productId][subproductIndex] = [];
        }
        
        if (Array.isArray(keys)) {
            stock[productId][subproductIndex].push(...keys);
        } else {
            stock[productId][subproductIndex].push(keys);
        }
        
        await this.save(stock);
        
        const addedCount = Array.isArray(keys) ? keys.length : 1;
        const newTotal = stock[productId][subproductIndex].length;
        console.log(`📦 Estoque adicionado: ${productId}[${subproductIndex}] +${addedCount} keys`);
        
        // Notificar sobre estoque restaurado se estava zerado
        if (newTotal === addedCount) {
            await this.notifyStockRestored(productId, subproductIndex, newTotal);
        }
        
        return newTotal;
    },

    async removeStock(productId, subproductIndex, quantity = 1) {
        const stock = await this.load();
        
        if (!stock[productId] || !stock[productId][subproductIndex]) {
            throw new Error('Produto ou plano não encontrado no estoque');
        }
        
        const availableKeys = stock[productId][subproductIndex];
        
        if (availableKeys.length < quantity) {
            throw new Error(`Estoque insuficiente. Disponível: ${availableKeys.length}, Solicitado: ${quantity}`);
        }
        
        const removedKeys = availableKeys.splice(0, quantity);
        const remainingStock = availableKeys.length;
        
        await this.save(stock);
        
        console.log(`📦 Estoque removido: ${productId}[${subproductIndex}] -${quantity} keys (restante: ${remainingStock})`);
        
        // Notificar sobre estoque baixo
        await this.checkLowStock(productId, subproductIndex, remainingStock);
        
        return removedKeys;
    },

    async getStock(productId, subproductIndex = null) {
        const stock = await this.load();
        
        if (subproductIndex !== null) {
            return stock[productId]?.[subproductIndex] || [];
        }
        
        return stock[productId] || {};
    },

    async getAvailableCount(productId, subproductIndex) {
        const stock = await this.getStock(productId, subproductIndex);
        return stock.length;
    },

    async hasAnyStock(productId) {
        const productStock = await this.getStock(productId);
        for (const keys of Object.values(productStock)) {
            if (Array.isArray(keys) && keys.length > 0) {
                return true;
            }
        }
        return false;
    },

    async hasStock(productId, subproductIndex, quantity = 1) {
        const available = await this.getAvailableCount(productId, subproductIndex);
        return available >= quantity;
    },

    async consumeKey(productId, subproductIndex) {
        try {
            const removedKeys = await this.removeStock(productId, subproductIndex, 1);
            return removedKeys[0];
        } catch (error) {
            console.error(`❌ Erro ao consumir key: ${error.message}`);
            return null;
        }
    },

    async clearStock(productId, subproductIndex = null) {
        const stock = await this.load();
        
        if (subproductIndex !== null) {
            if (stock[productId] && stock[productId][subproductIndex]) {
                const clearedCount = stock[productId][subproductIndex].length;
                stock[productId][subproductIndex] = [];
                await this.save(stock);
                console.log(`🗑️ Estoque limpo: ${productId}[${subproductIndex}] -${clearedCount} keys`);
                
                // Notificar sobre estoque zerado
                await this.notifyStockEmpty(productId, subproductIndex);
                
                return clearedCount;
            }
        } else {
            if (stock[productId]) {
                let totalCleared = 0;
                for (const subIndex in stock[productId]) {
                    totalCleared += stock[productId][subIndex].length;
                }
                delete stock[productId];
                await this.save(stock);
                console.log(`🗑️ Estoque completo limpo: ${productId} -${totalCleared} keys`);
                
                // Notificar sobre produto sem estoque
                await this.notifyProductOutOfStock(productId);
                
                return totalCleared;
            }
        }
        
        return 0;
    },

    async getAllStock() {
        return await this.load();
    },

    async getStockSummary() {
        const stock = await this.load();
        const products = await Products.load();
        const summary = {};
        
        for (const [productId, productStock] of Object.entries(stock)) {
            const product = products[productId];
            if (!product) continue;
            
            summary[productId] = {
                title: product.titulo,
                subproducts: {}
            };
            
            for (const [subIndex, keys] of Object.entries(productStock)) {
                const subproduct = product.subprodutos?.[parseInt(subIndex)];
                if (subproduct) {
                    summary[productId].subproducts[subIndex] = {
                        name: subproduct.nome,
                        price: subproduct.preco,
                        available: keys.length
                    };
                }
            }
        }
        
        return summary;
    },

    // ===== SISTEMA DE NOTIFICAÇÕES =====
    async checkLowStock(productId, subproductIndex, currentStock) {
        const threshold = 3; // Alerta quando estoque ≤ 3
        
        if (currentStock <= threshold) {
            if (currentStock === 0) {
                await this.notifyStockEmpty(productId, subproductIndex);
            } else {
                await this.notifyLowStock(productId, subproductIndex, currentStock);
            }
        }
    },

    async notifyStockEmpty(productId, subproductIndex) {
        try {
            if (!client || !client.isReady()) return;
            
            const logChannel = client.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (!logChannel) return;

            const products = await Products.load();
            const product = products[productId];
            if (!product) return;

            const subproduct = product.subprodutos?.[subproductIndex];
            if (!subproduct) return;

            const components = [
                { type: 10, content: '# ⚠️ ESTOQUE ESGOTADO!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **ALERTA CRÍTICO:** Um produto ficou sem estoque e não pode mais ser vendido.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📦 Produto:** ${product.titulo}\n**🏷️ Plano:** ${subproduct.nome}\n**📊 Estoque Atual:** 0 keys\n**🚨 Status:** ESGOTADO\n**⚠️ Ação Necessária:** Adicionar estoque imediatamente` },
                { type: 14, divider: true, spacing: 1 },
                { type: 1, components: [
                    { type: 2, style: 1, label: '📦 Adicionar Estoque', custom_id: `emergency_add_stock_${productId}_${subproductIndex}` },
                    { type: 2, style: 2, label: '📊 Ver Estoque Geral', custom_id: 'view_all_stock' }
                ]}
            ];

            await logChannel.send({
                content: '<@&1268000387827503176>', // Mencionar role de admin se existir
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });

            console.log(`🚨 ALERTA: Estoque esgotado - ${product.titulo} (${subproduct.nome})`);

        } catch (error) {
            console.error('❌ Erro enviando notificação de estoque esgotado:', error);
        }
    },

    async notifyLowStock(productId, subproductIndex, currentStock) {
        try {
            if (!client || !client.isReady()) return;
            
            const logChannel = client.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (!logChannel) return;

            const products = await Products.load();
            const product = products[productId];
            if (!product) return;

            const subproduct = product.subprodutos?.[subproductIndex];
            if (!subproduct) return;

            const urgencyLevel = currentStock === 1 ? 'CRÍTICO' : 'BAIXO';
            const alertColor = currentStock === 1 ? '🔴' : '🟡';

            const components = [
                { type: 10, content: `# ${alertColor} ESTOQUE ${urgencyLevel}!` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `> **Estoque ${urgencyLevel.toLowerCase()}:** Este produto está com poucas unidades disponíveis.` },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📦 Produto:** ${product.titulo}\n**🏷️ Plano:** ${subproduct.nome}\n**📊 Estoque Atual:** ${currentStock} keys\n**⚠️ Status:** Estoque ${urgencyLevel}\n**💡 Recomendação:** Reabastecer o estoque em breve` },
                { type: 14, divider: true, spacing: 1 },
                { type: 1, components: [
                    { type: 2, style: 1, label: '📦 Adicionar Estoque', custom_id: `quick_add_stock_${productId}_${subproductIndex}` }
                ]}
            ];

            await logChannel.send({
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });

            console.log(`⚠️ ALERTA: Estoque baixo - ${product.titulo} (${subproduct.nome}) - ${currentStock} keys restantes`);

        } catch (error) {
            console.error('❌ Erro enviando notificação de estoque baixo:', error);
        }
    },

    async notifyStockRestored(productId, subproductIndex, newStock) {
        try {
            if (!client || !client.isReady()) return;
            
            const logChannel = client.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (!logChannel) return;

            const products = await Products.load();
            const product = products[productId];
            if (!product) return;

            const subproduct = product.subprodutos?.[subproductIndex];
            if (!subproduct) return;

            const components = [
                { type: 10, content: '# ✅ ESTOQUE RESTAURADO!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Estoque reabastecido:** Produto voltou a ficar disponível para venda.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📦 Produto:** ${product.titulo}\n**🏷️ Plano:** ${subproduct.nome}\n**📊 Novo Estoque:** ${newStock} keys\n**✅ Status:** Disponível para venda` }
            ];

            await logChannel.send({
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });

            console.log(`✅ Estoque restaurado - ${product.titulo} (${subproduct.nome}) - ${newStock} keys`);

        } catch (error) {
            console.error('❌ Erro enviando notificação de estoque restaurado:', error);
        }
    },

    async notifyProductOutOfStock(productId) {
        try {
            if (!client || !client.isReady()) return;
            
            const logChannel = client.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (!logChannel) return;

            const products = await Products.load();
            const product = products[productId];
            if (!product) return;

            const components = [
                { type: 10, content: '# 🚨 PRODUTO SEM ESTOQUE!' },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **ALERTA MÁXIMO:** Todo o estoque de um produto foi removido.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**📦 Produto:** ${product.titulo}\n**📊 Status:** Completamente sem estoque\n**🚨 Impacto:** Produto indisponível para venda\n**⚠️ Ação Necessária:** Reabastecimento urgente` },
                { type: 14, divider: true, spacing: 1 },
                { type: 1, components: [
                    { type: 2, style: 4, label: '🆘 Reabastecer Urgente', custom_id: `emergency_restock_${productId}` }
                ]}
            ];

            await logChannel.send({
                content: '<@&1268000387827503176>', // Mencionar role de admin
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });

            console.log(`🚨 CRÍTICO: Produto completamente sem estoque - ${product.titulo}`);

        } catch (error) {
            console.error('❌ Erro enviando notificação de produto sem estoque:', error);
        }
    }
};

// ===== BALANCE SYSTEM =====
const BalanceSystem = {
    async load() { 
        return await Utils.loadJSON(CONFIG.BALANCE_FILE, {}); 
    },
    
    async save(data) { 
        await Utils.saveJSON(CONFIG.BALANCE_FILE, data); 
    },

    async getBalance(userId) {
        const balances = await this.load();
        return balances[userId] || 0;
    },

    async setBalance(userId, amount) {
        const balances = await this.load();
        balances[userId] = Math.max(0, amount);
        await this.save(balances);
        return balances[userId];
    },

    async addBalance(userId, amount, adminId = null) {
        if (amount <= 0) throw new Error('Valor deve ser positivo');
        
        const balances = await this.load();
        const currentBalance = balances[userId] || 0;
        const newBalance = currentBalance + amount;
        
        balances[userId] = newBalance;
        await this.save(balances);
        
        await this.logTransaction({
            userId,
            type: 'add',
            amount,
            balanceBefore: currentBalance,
            balanceAfter: newBalance,
            adminId,
            timestamp: new Date().toISOString()
        });
        
        console.log(`💰 Saldo adicionado: ${userId} +R$ ${amount.toFixed(2)} (novo: R$ ${newBalance.toFixed(2)})`);
        return newBalance;
    },

    async removeBalance(userId, amount, adminId = null) {
        if (amount <= 0) throw new Error('Valor deve ser positivo');
        
        const balances = await this.load();
        const currentBalance = balances[userId] || 0;
        const newBalance = Math.max(0, currentBalance - amount);
        
        balances[userId] = newBalance;
        await this.save(balances);
        
        await this.logTransaction({
            userId,
            type: 'remove',
            amount,
            balanceBefore: currentBalance,
            balanceAfter: newBalance,
            adminId,
            timestamp: new Date().toISOString()
        });
        
        console.log(`💸 Saldo removido: ${userId} -R$ ${amount.toFixed(2)} (novo: R$ ${newBalance.toFixed(2)})`);
        return newBalance;
    },

    async consumeBalance(userId, amount, description = 'Purchase') {
        if (amount <= 0) throw new Error('Valor deve ser positivo');
        
        const balances = await this.load();
        const currentBalance = balances[userId] || 0;
        
        if (currentBalance < amount) {
            throw new Error(`Saldo insuficiente. Disponível: R$ ${currentBalance.toFixed(2)}, Necessário: R$ ${amount.toFixed(2)}`);
        }
        
        const newBalance = currentBalance - amount;
        balances[userId] = newBalance;
        await this.save(balances);
        
        await this.logTransaction({
            userId,
            type: 'consume',
            amount,
            balanceBefore: currentBalance,
            balanceAfter: newBalance,
            description,
            timestamp: new Date().toISOString()
        });
        
        console.log(`🛒 Saldo consumido: ${userId} -R$ ${amount.toFixed(2)} (${description})`);
        return newBalance;
    },

    async hasBalance(userId, amount) {
        const balance = await this.getBalance(userId);
        return balance >= amount;
    },

    async logTransaction(transactionData) {
        try {
            const transactions = await Utils.loadJSON(CONFIG.BALANCE_TRANSACTIONS_FILE, []);
            transactions.push({
                id: Utils.generateTransactionId(),
                ...transactionData
            });
            await Utils.saveJSON(CONFIG.BALANCE_TRANSACTIONS_FILE, transactions);
        } catch (error) {
            console.error('❌ Erro salvando transação de saldo:', error);
        }
    },

    async getTopBalances(limit = 10) {
        const balances = await this.load();
        return Object.entries(balances)
            .sort(([,a], [,b]) => b - a)
            .slice(0, limit)
            .map(([userId, balance]) => ({ userId, balance }));
    }
};

// ===== CUSTOM PAYMENT SYSTEM =====
const CustomPaymentSystem = {
    async load() {
        return await Utils.loadJSON(CONFIG.CUSTOM_PAYMENTS_FILE, []);
    },

    async save(payments) {
        await Utils.saveJSON(CONFIG.CUSTOM_PAYMENTS_FILE, payments);
    },

    async create(userId, userTag, valor, description, channelId = null) {
        const payments = await this.load();
        const txid = Utils.generateTransactionId();
        const expiresAt = Date.now() + CONFIG.PAYMENT_TIMEOUT;

        const payment = {
            id: txid,
            userId,
            userTag,
            valor,
            description,
            channelId,
            status: 'pending',
            createdAt: Date.now(),
            expiresAt,
            confirmed: false,
            pixCode: null,
            efiTxid: null
        };

        payments.push(payment);
        await this.save(payments);

        console.log(`💰 Pagamento personalizado criado: ${txid} - R$ ${valor.toFixed(2)} - ${userTag}`);
        return payment;
    },

    async confirm(txid, confirmedBy = null, confirmationType = 'automatic') {
        const payments = await this.load();
        const paymentIndex = payments.findIndex(p => p.id === txid);

        if (paymentIndex === -1) {
            throw new Error('Pagamento não encontrado');
        }

        const payment = payments[paymentIndex];

        if (payment.confirmed) {
            throw new Error('Pagamento já confirmado');
        }

        if (Date.now() > payment.expiresAt) {
            throw new Error('Pagamento expirado');
        }

        payment.confirmed = true;
        payment.status = 'confirmed';
        payment.confirmedAt = Date.now();
        payment.confirmedBy = confirmedBy;
        payment.confirmationType = confirmationType;

        payments[paymentIndex] = payment;
        await this.save(payments);

        console.log(`✅ Pagamento personalizado confirmado: ${txid} - ${payment.userTag}`);
        return payment;
    },

    async expire(txid) {
        const payments = await this.load();
        const paymentIndex = payments.findIndex(p => p.id === txid);

        if (paymentIndex !== -1) {
            payments[paymentIndex].status = 'expired';
            payments[paymentIndex].expiredAt = Date.now();
            await this.save(payments);
            console.log(`⏰ Pagamento personalizado expirado: ${txid}`);
        }
    },

    async getActivePayments() {
        const payments = await this.load();
        const now = Date.now();
        return payments.filter(p => 
            p.status === 'pending' && 
            !p.confirmed && 
            p.expiresAt > now
        );
    },

    async cleanExpired() {
        const payments = await this.load();
        const now = Date.now();
        let cleaned = 0;

        for (const payment of payments) {
            if (payment.status === 'pending' && !payment.confirmed && payment.expiresAt <= now) {
                payment.status = 'expired';
                payment.expiredAt = now;
                cleaned++;
            }
        }

        if (cleaned > 0) {
            await this.save(payments);
            console.log(`🧹 ${cleaned} pagamentos personalizados expirados limpos`);
        }

        return cleaned;
    }
};

// ===== PIX =====
const PIX = {
    async createCharge(amount, description) {
        if (!efi) throw new Error('EFI Pay não configurado');
        
        const chargeData = {
            calendario: { expiracao: 3600 },
            valor: { original: amount.toFixed(2) },
            chave: process.env.PIX_KEY,
            solicitacaoPagador: description,
        };

        const result = await efi.pixCreateImmediateCharge({}, chargeData);
        console.log(`💰 PIX criado: ${result.txid} - R$ ${amount.toFixed(2)}`);
        return result;
    },

    async generateQRCode(pixCode, fileName) {
        const tempDir = path.join(__dirname, 'temp');
        const logoPath = path.join(__dirname, 'assets', 'logo.png');
        const filePath = path.join(tempDir, fileName);
        
        try {
            console.log('🔍 [QRCode] Gerando QR Code usando biblioteca local...');
            
            // Configurações do QR Code com cores laranja
            const qrOptions = {
                color: { dark: '#FF8C00', light: '#FFFFFF' },
                width: 400,
                margin: 3,
                errorCorrectionLevel: 'H'
            };
            
            // Tentar gerar com logo primeiro
            if (fsSync.existsSync(logoPath)) {
                console.log('🎨 Gerando QR Code com logo personalizada...');
                await this.generateQRWithLogo(pixCode, filePath, logoPath, qrOptions);
            } else {
                console.log('⚠️ Logo não encontrada, gerando QR Code padrão...');
                await QRCode.toFile(filePath, pixCode, qrOptions);
            }
            
            console.log('✅ [QRCode] QR Code gerado com sucesso!');
            Utils.cleanupTempFile(filePath);
            return filePath;
            
        } catch (error) {
            console.error('❌ [QRCode] Erro ao gerar QR Code:', error);
            
            // Fallback simples em caso de erro
            try {
                console.log('🔄 [QRCode] Tentando fallback simples...');
                await QRCode.toFile(filePath, pixCode, {
                    color: { dark: '#FF8C00', light: '#FFFFFF' },
                    width: 300,
                    margin: 2
                });
                
                console.log('✅ [QRCode] QR Code gerado com fallback!');
                Utils.cleanupTempFile(filePath);
                return filePath;
                
            } catch (fallbackError) {
                console.error('❌ [QRCode] Erro no fallback:', fallbackError);
                throw fallbackError;
            }
        }
    },

    async generateQRWithLogo(pixCode, outputPath, logoPath, qrOptions) {
        try {
            const sharp = require('sharp');
            const QRCodeLib = require('qrcode');
            
            // Gerar QR Code em buffer
            const qrBuffer = await QRCodeLib.toBuffer(pixCode, qrOptions);
            
            // Calcular tamanho da logo (20% do QR Code)
            const logoSize = Math.floor(qrOptions.width * 0.2);
            
            // Redimensionar logo
            const resizedLogo = await sharp(logoPath)
                .resize(logoSize, logoSize, { 
                    fit: 'inside',
                    withoutEnlargement: true,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }
                })
                .png()
                .toBuffer();
            
            // Combinar QR Code com logo
            await sharp(qrBuffer)
                .composite([{
                    input: resizedLogo,
                    gravity: 'center'
                }])
                .png()
                .toFile(outputPath);
                
            console.log('✅ QR Code com logo gerado com sucesso!');
            return outputPath;
            
        } catch (error) {
            console.error('❌ Erro ao adicionar logo ao QR Code:', error);
            
            // Fallback: gerar QR Code simples sem logo
            try {
                const QRCodeLib = require('qrcode');
                await QRCodeLib.toFile(outputPath, pixCode, qrOptions);
                console.log('✅ QR Code simples gerado como fallback!');
                return outputPath;
            } catch (fallbackError) {
                console.error('❌ Erro no fallback do QR Code:', fallbackError);
                throw fallbackError;
            }
        }
    },

    async checkStatus(txid) {
        try {
            if (!efi) return false;
            const status = await efi.pixDetailCharge({ txid });
            return status.status === 'CONCLUIDA';
        } catch (error) {
            console.error(`❌ Erro verificar PIX ${txid}:`, error.message);
            return false;
        }
    },

    monitorPayment(txid, channelId, userId, userTag, product, plan, price, paymentMethod) {
        console.log(`🔍 Monitoramento PIX iniciado: ${txid}`);
        
        const checkInterval = setInterval(async () => {
            try {
                if (await this.checkStatus(txid)) {
                    console.log(`✅ PIX CONFIRMADO: ${txid} - ${userTag}`);
                    
                    clearInterval(checkInterval);
                    pixPayments.delete(txid);
                    
                    const user = await client.users.fetch(userId);
                    const channel = client.channels.cache.get(channelId);
                    const guild = channel?.guild;
                    
                    const deliveryResult = await DeliverySystem.deliverKey(user, product, plan, price, paymentMethod, guild);
                    const keyDelivered = deliveryResult.success;
                    const pricingInfo = await PricingSystem.calculateFinalPrice(parseFloat(price.replace(/[^0-9.]/g, '')), userId);
                    
                    await TransactionSystem.save({
                        userId, userTag, product, plan, price, paymentMethod,
                        status: 'completed', txid, keyDelivered
                    });

                    // Registrar venda no sistema de analytics
                    await AnalyticsSystem.recordSale({
                        userId, userTag, product, plan, price, paymentMethod: 'pix'
                    });
                    
                    await Logger.paymentConfirmed({
                        userId, userTag, product, plan, price,
                        paymentMethod: 'PIX', txid, keyDelivered: keyDelivered,
                        discounts: pricingInfo.discounts, deliveredKey: deliveryResult.key
                    });
                    
                    if (channel) await Logger.approveAutomatically(channel, userId, keyDelivered);
                }
            } catch (error) {
                console.error(`❌ Erro monitorar PIX ${txid}:`, error.message);
            }
        }, CONFIG.CHECK_INTERVAL);

        setTimeout(() => {
            clearInterval(checkInterval);
            pixPayments.delete(txid);
            console.log(`⏰ PIX timeout: ${txid}`);
        }, CONFIG.PAYMENT_TIMEOUT);

        pixPayments.set(txid, { 
            interval: checkInterval, userTag, product, plan, price, startTime: Date.now()
        });
    },

    monitorCustomPayment(payment, channelId = null) {
        console.log(`🔍 Monitoramento PIX personalizado iniciado: ${payment.id} (EFI: ${payment.efiTxid || 'N/A'})`);
        
        const checkInterval = setInterval(async () => {
            try {
                if (payment.efiTxid && await this.checkStatus(payment.efiTxid)) {
                    console.log(`✅ PIX PERSONALIZADO CONFIRMADO: ${payment.id} (EFI: ${payment.efiTxid}) - ${payment.userTag}`);
                    
                    clearInterval(checkInterval);
                    customPixPayments.delete(payment.id);
                    
                    await CustomPaymentSystem.confirm(payment.id, null, 'automatic');
                    
                    const user = await client.users.fetch(payment.userId);
                    
                    await Logger.customPaymentConfirmed({
                        userId: payment.userId,
                        userTag: payment.userTag,
                        valor: payment.valor,
                        description: payment.description,
                        txid: payment.id,
                        efiTxid: payment.efiTxid,
                        confirmationType: 'automatic'
                    });
                    
                    // Verificar se há uma compra pendente do carrinho
                    if (global.pendingPurchases && global.pendingPurchases.has(payment.id)) {
                        const purchaseData = global.pendingPurchases.get(payment.id);
                        
                        if (purchaseData.type === 'multiple') {
                            // Compra múltipla
                            console.log(`🛒 Finalizando compra múltipla pendente do carrinho com ${purchaseData.cart.items.length} itens`);
                            
                            try {
                                // Processar todos os itens do carrinho
                                const allKeys = [];
                                const transactions = [];
                                
                                for (const item of purchaseData.cart.items) {
                                    // Verificar estoque novamente
                                    const stockAvailable = await StockSystem.getAvailableCount(item.productId, item.subIndex);
                                    if (stockAvailable < item.quantity) {
                                        console.error(`❌ Estoque insuficiente para ${item.productId}[${item.subIndex}]: ${stockAvailable} < ${item.quantity}`);
                                        continue;
                                    }
                                    
                                    // Remover chaves do estoque
                                    const keys = await StockSystem.removeStock(item.productId, item.subIndex, item.quantity);
                                    if (keys && keys.length > 0) {
                                        allKeys.push(...keys);
                                        
                                        // Registrar transação individual
                                        const transaction = {
                                            id: Utils.generateTransactionId(),
                                            userId: payment.userId,
                                            userTag: payment.userTag,
                                            productId: item.productId,
                                            productTitle: item.productTitle,
                                            subproductName: item.subproductName,
                                            quantity: item.quantity,
                                            originalPrice: item.price * item.quantity,
                                            finalPrice: item.price * item.quantity,
                                            discountApplied: false,
                                            paymentMethod: 'mixed',
                                            balanceUsed: purchaseData.balanceUsed / purchaseData.cart.items.length, // Proporcional
                                            pixAmount: purchaseData.remainingPrice / purchaseData.cart.items.length, // Proporcional
                                            timestamp: new Date().toISOString(),
                                            keys,
                                            channelId: purchaseData.channelId,
                                            pixTxid: payment.efiTxid
                                        };
                                        
                                        transactions.push(transaction);
                                        await TransactionSystem.save(transaction);
                                        
                                        // Atualizar estatísticas do produto
                                        const productsData = await Products.load();
                                        if (productsData[item.productId]) {
                                            productsData[item.productId].sales_count = (productsData[item.productId].sales_count || 0) + item.quantity;
                                            productsData[item.productId].total_revenue = (productsData[item.productId].total_revenue || 0) + (item.price * item.quantity);
                                            await Products.save(productsData);
                                        }
                                    }
                                }
                                
                                if (allKeys.length === 0) {
                                    console.error('❌ Nenhuma chave foi processada para compra múltipla');
                                    return;
                                }
                                
                                // Embed de confirmação da compra múltipla
                                let itemsText = `🎉 **Pagamento PIX Confirmado!** Sua compra foi processada com sucesso!\n\n`;
                                itemsText += `🛒 **Itens Comprados:** ${purchaseData.cart.items.length}\n`;
                                itemsText += `💰 **Saldo usado:** R$ ${purchaseData.balanceUsed.toFixed(2)}\n`;
                                itemsText += `💳 **PIX pago:** R$ ${purchaseData.remainingPrice.toFixed(2)}\n`;
                                itemsText += `💵 **Valor Total:** R$ ${purchaseData.totalPrice.toFixed(2)}\n\n`;
                                itemsText += `**🔑 Suas chaves:**\n\`\`\`\n${allKeys.join('\n')}\n\`\`\``;
                                
                                const successEmbed = {
                                    type: 17,
                                    accent_color: null,
                                    spoiler: false,
                                    components: [
                                        {
                                            type: 9,
                                            accessory: {
                                                type: 2,
                                                style: 5,
                                                label: "Nosso Site",
                                                emoji: null,
                                                disabled: false,
                                                url: "https://rootunk.store"
                                            },
                                            components: [
                                                {
                                                    type: 10,
                                                    content: "# ✅ **Compra Múltipla Finalizada!**"
                                                }
                                            ]
                                        },
                                        {
                                            type: 10,
                                            content: itemsText
                                        }
                                    ]
                                };
                                
                                // Enviar confirmação no canal
                                if (purchaseData.channelId) {
                                    try {
                                        const channel = client.channels.cache.get(purchaseData.channelId);
                                        if (channel && !channel.deleted) {
                                            await channel.send({
                                                flags: ['IsComponentsV2'],
                                                components: [successEmbed]
                                            });
                                        }
                                    } catch (channelError) {
                                        console.error('Erro enviando confirmação no canal:', channelError);
                                    }
                                }
                                
                                // Limpar carrinho e agendar deleção do canal
                                CartManager.clearCart(purchaseData.channelId);
                                
                                setTimeout(async () => {
                                    try {
                                        const channel = client.channels.cache.get(purchaseData.channelId);
                                        if (channel && !channel.deleted) {
                                            await channel.delete('Compra múltipla finalizada com PIX');
                                        }
                                    } catch (error) {
                                        console.error('Erro fechando canal:', error);
                                    }
                                }, 30000);
                                
                                // Remover dados pendentes
                                global.pendingPurchases.delete(payment.id);
                                
                                console.log(`✅ Compra múltipla do carrinho finalizada com sucesso: ${purchaseData.cart.items.length} itens - ENVIANDO COMPONENTES MULTIPLOS`);
                                
                                // Enviar chaves no privado do usuário
                                try {
                                    const user = await client.users.fetch(payment.userId);
                                    const privateEmbed = {
                                        type: 17,
                                        accent_color: null,
                                        spoiler: false,
                                        components: [
                                            {
                                                type: 9,
                                                accessory: {
                                                    type: 2,
                                                    style: 5,
                                                    label: "Tutorial: ",
                                                    emoji: null,
                                                    disabled: false,
                                                    url: "http://rootunk.store/tutoriais."
                                                },
                                                components: [
                                                    {
                                                        type: 10,
                                                        content: "# 💰 Suas Chaves - Root@Unk"
                                                    }
                                                ]
                                            },
                                            {
                                                type: 9,
                                                accessory: {
                                                    type: 2,
                                                    style: 5,
                                                    label: "Download",
                                                    emoji: null,
                                                    disabled: false,
                                                    url: "https://softwares.squareweb.app/"
                                                },
                                                components: [
                                                    {
                                                        type: 10,
                                                        content: `> 🎉 **Compra Finalizada!**\n> Suas chaves foram entregues com sucesso.\n\n📦 **Produto:** Múltiplos Itens (${purchaseData.cart.items.length})\n💰 **Valor Total:** R$ ${purchaseData.totalPrice.toFixed(2)}\n💳 **Forma de Pagamento:** Misto (Saldo + PIX)`
                                                    }
                                                ]
                                            }
                                        ]
                                    };

                                    const privateEmbedSecond = {
                                        type: 17,
                                        accent_color: null,
                                        spoiler: false,
                                        components: [
                                            {
                                                type: 10,
                                                content: `🔑 **Key:**\n\`\`\`\n${allKeys.join('\n')}\n\`\`\``
                                            }
                                        ]
                                    };

                                    const privateEmbedThird = {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 5,
                                                label: "Feedback",
                                                emoji: null,
                                                disabled: false,
                                                url: "https://discord.com/channels/1197909142208253972/1263274741624733738"
                                            }
                                        ]
                                    };

                                    // Enviar os três componentes para compra múltipla
                                    await user.send({
                                        flags: ['IsComponentsV2'],
                                        components: [privateEmbed, privateEmbedSecond, privateEmbedThird]
                                    });
                                    
                                    console.log(`📬 Chaves enviadas no privado para ${payment.userTag}`);
                                } catch (privateError) {
                                    console.error('❌ Erro enviando chaves no privado:', privateError);
                                }
                                
                            } catch (error) {
                                console.error('❌ Erro ao finalizar compra múltipla pendente:', error);
                            }
                        } else {
                            // Compra única
                            console.log(`🛒 Finalizando compra única pendente do carrinho: ${purchaseData.productId}[${purchaseData.subIndex}]`);
                            
                            try {
                                // Processar entrega das chaves
                                const keys = await StockSystem.removeStock(purchaseData.productId, purchaseData.subIndex, purchaseData.item.quantity);
                                
                                if (!keys || keys.length === 0) {
                                    console.error('❌ Erro ao processar estoque para compra pendente');
                                    return;
                                }
                                
                                // Registrar transação
                                const transaction = {
                                    id: Utils.generateTransactionId(),
                                    userId: payment.userId,
                                    userTag: payment.userTag,
                                    productId: purchaseData.productId,
                                    productTitle: purchaseData.product.titulo,
                                    subproductName: purchaseData.subproduct.nome,
                                    quantity: purchaseData.item.quantity,
                                    originalPrice: purchaseData.subproduct.preco * purchaseData.item.quantity,
                                    finalPrice: purchaseData.finalPrice,
                                    discountApplied: false, // Será verificado se necessário
                                    paymentMethod: 'mixed',
                                    balanceUsed: purchaseData.balanceUsed,
                                    pixAmount: purchaseData.remainingPrice,
                                    timestamp: new Date().toISOString(),
                                    keys,
                                    channelId: purchaseData.channelId,
                                    pixTxid: payment.efiTxid
                                };
                                
                                await TransactionSystem.save(transaction);
                                
                                // Atualizar estatísticas do produto
                                const productsData = await Products.load();
                                if (productsData[purchaseData.productId]) {
                                    productsData[purchaseData.productId].sales_count = (productsData[purchaseData.productId].sales_count || 0) + purchaseData.item.quantity;
                                    productsData[purchaseData.productId].total_revenue = (productsData[purchaseData.productId].total_revenue || 0) + purchaseData.finalPrice;
                                    await Products.save(productsData);
                                }
                                
                                // Embed de confirmação da compra
                                const successEmbed = {
                                    type: 17,
                                    accent_color: null,
                                    spoiler: false,
                                    components: [
                                        {
                                            type: 9,
                                            accessory: {
                                                type: 2,
                                                style: 5,
                                                label: "Nosso Site",
                                                emoji: null,
                                                disabled: false,
                                                url: "https://rootunk.store"
                                            },
                                            components: [
                                                {
                                                    type: 10,
                                                    content: "# ✅ **Compra Finalizada!**"
                                                }
                                            ]
                                        },
                                        {
                                            type: 10,
                                            content: `🎉 **Pagamento PIX Confirmado!** Sua compra foi processada com sucesso!\n\n<:vendendo:1380665117473247356> **Produto:** ${purchaseData.product.titulo} - ${purchaseData.subproduct.nome}\n<:moedas:1380666331627786501> **Quantidade:** ${purchaseData.item.quantity}\n<:moedas:1380666331627786501> **Valor Total:** R$ ${purchaseData.finalPrice.toFixed(2)}\n💰 **Saldo usado:** R$ ${purchaseData.balanceUsed.toFixed(2)}\n💳 **PIX pago:** R$ ${purchaseData.remainingPrice.toFixed(2)}\n\n**🔑 Suas chaves:**\n\`\`\`\n${keys.join('\n')}\n\`\`\``
                                        }
                                    ]
                                };
                                
                                // Enviar confirmação no canal
                                if (purchaseData.channelId) {
                                    try {
                                        const channel = client.channels.cache.get(purchaseData.channelId);
                                        if (channel && !channel.deleted) {
                                            await channel.send({
                                                flags: ['IsComponentsV2'],
                                                components: [successEmbed]
                                            });
                                        }
                                    } catch (channelError) {
                                        console.error('Erro enviando confirmação no canal:', channelError);
                                    }
                                }
                                
                                // Limpar carrinho e agendar deleção do canal
                                CartManager.clearCart(purchaseData.channelId);
                                
                                setTimeout(async () => {
                                    try {
                                        const channel = client.channels.cache.get(purchaseData.channelId);
                                        if (channel && !channel.deleted) {
                                            await channel.delete('Compra finalizada com PIX');
                                        }
                                    } catch (error) {
                                        console.error('Erro fechando canal:', error);
                                    }
                                }, 30000);
                                
                                // Remover dados pendentes
                                global.pendingPurchases.delete(payment.id);
                                
                                console.log(`✅ Compra única do carrinho finalizada com sucesso: ${purchaseData.productId}[${purchaseData.subIndex}]`);
                                
                                // Enviar chaves no privado do usuário
                                try {
                                    const user = await client.users.fetch(payment.userId);
                                    const privateEmbed = {
                                        type: 17,
                                        accent_color: null,
                                        spoiler: false,
                                        components: [
                                            {
                                                type: 9,
                                                accessory: {
                                                    type: 2,
                                                    style: 5,
                                                    label: "Tutorial: ",
                                                    emoji: null,
                                                    disabled: false,
                                                    url: "http://rootunk.store/tutoriais."
                                                },
                                                components: [
                                                    {
                                                        type: 10,
                                                        content: "# 💰 Suas Chaves - Root@Unk"
                                                    }
                                                ]
                                            },
                                            {
                                                type: 9,
                                                accessory: {
                                                    type: 2,
                                                    style: 5,
                                                    label: "Download",
                                                    emoji: null,
                                                    disabled: false,
                                                    url: "https://softwares.squareweb.app/"
                                                },
                                                components: [
                                                    {
                                                        type: 10,
                                                        content: `> 🎉 **Compra Finalizada!**\n> Suas chaves foram entregues com sucesso.\n\n📦 **Produto:** ${purchaseData.product.titulo} — ${purchaseData.subproduct.nome}\n💰 **Valor Total:** R$ ${purchaseData.finalPrice.toFixed(2)}\n💳 **Forma de Pagamento:** Misto (Saldo + PIX)`
                                                    }
                                                ]
                                            }
                                        ]
                                    };

                                    const privateEmbedSecond = {
                                        type: 17,
                                        accent_color: null,
                                        spoiler: false,
                                        components: [
                                            {
                                                type: 10,
                                                content: `🔑 **Key:**\n\`\`\`\n${keys.join('\n')}\n\`\`\``
                                            }
                                        ]
                                    };

                                    const privateEmbedThird = {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 5,
                                                label: "Feedback",
                                                emoji: null,
                                                disabled: false,
                                                url: "https://discord.com/channels/1197909142208253972/1263274741624733738"
                                            }
                                        ]
                                    };
                                    
                                    await user.send({
                                        flags: ['IsComponentsV2'],
                                        components: [privateEmbed, privateEmbedSecond, privateEmbedThird]
                                    });
                                    
                                    console.log(`📬 Chaves enviadas no privado para ${payment.userTag}`);
                                } catch (privateError) {
                                    console.error('❌ Erro enviando chaves no privado:', privateError);
                                }
                                
                            } catch (error) {
                                console.error('❌ Erro ao finalizar compra pendente:', error);
                            }
                        }
                    } else {
                        // Pagamento personalizado normal (não do carrinho)
                        if (channelId) {
                            try {
                                const channel = client.channels.cache.get(channelId);
                                if (channel && !channel.deleted) {
                                    await channel.send({
                                        flags: ['IsComponentsV2'],
                                        components: ComponentBuilder.buildCustomPixConfirmed(payment.userTag, payment.valor, payment.description, payment.id, payment.efiTxid)
                                    });
                                }
                            } catch (channelError) {
                                console.error('Erro notificando canal:', channelError);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Erro monitorar PIX personalizado ${payment.id}:`, error.message);
            }
        }, CONFIG.CHECK_INTERVAL);

        setTimeout(async () => {
            clearInterval(checkInterval);
            customPixPayments.delete(payment.id);
            await CustomPaymentSystem.expire(payment.id);
            console.log(`⏰ PIX personalizado timeout: ${payment.id}`);
        }, CONFIG.PAYMENT_TIMEOUT);

        customPixPayments.set(payment.id, { 
            interval: checkInterval, 
            payment: payment, 
            startTime: Date.now()
        });
    },

    monitorMixedPayment(txid, channelId, userId, userTag, product, plan, balanceToUse, remainingPrice, paymentMethod) {
        console.log(`🔍 Monitoramento PIX misto iniciado: ${txid} - Saldo: R$ ${balanceToUse.toFixed(2)}, PIX: R$ ${remainingPrice.toFixed(2)}`);
        
        const checkInterval = setInterval(async () => {
            try {
                if (await this.checkStatus(txid)) {
                    console.log(`✅ PIX MISTO CONFIRMADO: ${txid} - ${userTag}`);
                    
                    clearInterval(checkInterval);
                    pixPayments.delete(txid);
                    
                    const user = await client.users.fetch(userId);
                    const channel = client.channels.cache.get(channelId);
                    const guild = channel?.guild;
                    
                    const cartData = global.cartDataMap?.get(channelId);
                    if (!cartData) {
                        console.error('❌ Dados do carrinho misto não encontrados');
                        return;
                    }
                    
                    try {
                        const remainingBalance = await BalanceSystem.consumeBalance(
                            userId, 
                            balanceToUse, 
                            `${product} - ${plan} (Pagamento Misto - Saldo)`
                        );
                        
                        const deliveryResult = await DeliverySystem.deliverKey(user, product, plan, `R$ ${(balanceToUse + remainingPrice).toFixed(2)}`, 'mixed', guild);
                        const keyDelivered = deliveryResult.success;
                        
                        await TransactionSystem.save({
                            userId, userTag, product, plan, 
                            price: `R$ ${(balanceToUse + remainingPrice).toFixed(2)}`,
                            paymentMethod: 'mixed',
                            status: 'completed', 
                            txid, 
                            keyDelivered,
                            balanceUsed: balanceToUse,
                            pixAmount: remainingPrice
                        });

                        // Registrar venda no sistema de analytics
                        await AnalyticsSystem.recordSale({
                            userId, userTag, product, plan, 
                            price: `R$ ${(balanceToUse + remainingPrice).toFixed(2)}`,
                            paymentMethod: 'mixed'
                        });
                        
                        await Logger.mixedPaymentConfirmed({
                            userId, userTag, product, plan,
                            totalPrice: balanceToUse + remainingPrice,
                            balanceUsed: balanceToUse,
                            pixAmount: remainingPrice,
                            paymentMethod: 'MISTO', 
                            txid, 
                            keyDelivered,
                            deliveredKey: deliveryResult.key
                        });
                        
                        const products = await Products.load();
                        const productId = Object.entries(products).find(([id, p]) => p.titulo === product)?.[0];
                        if (productId) {
                            await Products.updateSalesStats(productId, balanceToUse + remainingPrice);
                        }
                        
                        if (await Resellers.isReseller(userId)) {
                            await Resellers.updateStats(userId, balanceToUse + remainingPrice);
                        }
                        
                        if (channel) {
                            const components = [
                                { type: 10, content: '# ✅ Pagamento Misto Confirmado!' },
                                { type: 14, divider: true, spacing: 1 },
                                { type: 10, content: '> **Compra processada com sucesso!** Pagamento híbrido confirmado automaticamente.' },
                                { type: 14, divider: false, spacing: 1 },
                                { type: 10, content: `**👤 Cliente:** ${userTag}\n**📦 Produto:** ${product} - ${plan}\n**💰 Saldo Usado:** R$ ${balanceToUse.toFixed(2)}\n**💳 PIX Pago:** R$ ${remainingPrice.toFixed(2)}\n**💰 Saldo Restante:** R$ ${remainingBalance.toFixed(2)}\n**🚀 Entrega:** ${keyDelivered ? '✅ Key enviada via DM' : '⚙️ Manual'}` },
                                { type: 14, divider: true, spacing: 1 },
                                { type: 10, content: '🎉 **Obrigado!** Sua compra foi processada com sucesso.' }
                            ];
                            
                            await channel.send({
                                flags: ['IsComponentsV2'],
                                components: [{ type: 17, components }]
                            });
                            
                            global.cartDataMap?.delete(channelId);
                            
                            setTimeout(async () => {
                                try {
                                    if (channel && !channel.deleted) {
                                        await channel.delete('Pagamento misto confirmado - fechamento automático');
                                    }
                                } catch (error) {
                                    console.error('Erro fechando canal após pagamento misto:', error);
                                }
                            }, 30000);
                        }
                        
                    } catch (error) {
                        console.error('❌ Erro processando pagamento misto:', error);
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setTitle('❌ Erro no Pagamento Misto')
                                .setDescription(`Erro ao processar: ${error.message}`)
                                .setColor('#ff0000');
                            await channel.send({ embeds: [embed] });
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Erro monitorar PIX misto ${txid}:`, error.message);
            }
        }, CONFIG.CHECK_INTERVAL);

        setTimeout(() => {
            clearInterval(checkInterval);
            pixPayments.delete(txid);
            console.log(`⏰ PIX misto timeout: ${txid}`);
        }, CONFIG.PAYMENT_TIMEOUT);

        pixPayments.set(txid, { 
            interval: checkInterval, userTag, product, plan, 
            price: `Mixed: R$ ${balanceToUse.toFixed(2)} + R$ ${remainingPrice.toFixed(2)}`, 
            startTime: Date.now(), 
            isMixed: true 
        });
    }
};

// ===== DELIVERY SYSTEM =====
const DeliverySystem = {
    async deliverKey(user, productName, planName, price, paymentMethod, guild = null) {
        try {
            const products = await Products.load();
            
            const [productId, productData] = Object.entries(products)
                .find(([id, product]) => product.titulo === productName) || [];
            
            if (!productData) {
                await this.sendError(user, 'Produto não encontrado', productName, planName, price);
                return { success: false, key: null };
            }

            const subproductIndex = this.findSubproductIndex(productData.subprodutos, planName);
            if (subproductIndex === -1) {
                await this.sendError(user, 'Plano não encontrado', productName, planName, price);
                return { success: false, key: null };
            }

            // Verificar se há estoque disponível
            const hasStock = await StockSystem.hasStock(productId, subproductIndex, 1);
            if (!hasStock) {
                await this.sendError(user, 'Produto esgotado', productName, planName, price);
                return { success: false, key: null };
            }

            // Consumir uma key do estoque
            const key = await StockSystem.consumeKey(productId, subproductIndex);
            if (!key) {
                await this.sendError(user, 'Erro ao obter key do estoque', productName, planName, price);
                return { success: false, key: null };
            }

            await this.sendKey(user, productName, planName, price, paymentMethod, key);
            
            await Products.updateSalesStats(productId, parseFloat(price.replace(/[^0-9.]/g, '')));
            if (await Resellers.isReseller(user.id)) {
                await Resellers.updateStats(user.id, parseFloat(price.replace(/[^0-9.]/g, '')));
            }
            
            if (guild) {
                await CustomerRoleSystem.giveCustomerRole(guild, user.id);
            }
            
            console.log(`🎉 KEY ENTREGUE: ${productName} | ${planName} | ${user.tag} | Key: ${key.slice(0, 8)}...`);
            return { success: true, key: key };

        } catch (error) {
            console.error('❌ Erro na entrega de key:', error);
            await this.sendError(user, 'Erro inesperado na entrega', productName, planName, price);
            return { success: false, key: null };
        }
    },

    findSubproductIndex(subproducts, planName) {
        return subproducts.findIndex(sub => {
            const normalize = str => str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\s]/g, '');
            return normalize(sub.nome) === normalize(planName);
        });
    },

    async sendKey(user, productName, planName, price, paymentMethod, key) {
        const transactionId = Utils.generateTransactionId();
        
        await user.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildKeyDelivery(productName, planName, price, paymentMethod, key, transactionId)]
        });
    },

    async sendError(user, error, product, plan, price) {
        const embed = new EmbedBuilder()
            .setTitle('❌ Erro na Entrega')
            .setDescription(`${user.username}, ${error}.\n\nNossa equipe foi notificada.`)
            .addFields(
                { name: 'Produto', value: product },
                { name: 'Plano', value: plan },
                { name: 'Preço', value: price }
            )
            .setColor('#ff0000')
            .setTimestamp();

        await user.send({ embeds: [embed] });
    }
};

// ===== TRANSACTION SYSTEM =====
const TransactionSystem = {
    async save(transactionData) {
        try {
            const transactions = await Utils.loadJSON(CONFIG.TRANSACTIONS_FILE, []);
            const transactionId = Utils.generateTransactionId();
            transactions.push({
                ...transactionData,
                id: transactionId,
                timestamp: new Date().toISOString()
            });
            await Utils.saveJSON(CONFIG.TRANSACTIONS_FILE, transactions);
            console.log('💾 Nova transação registrada');
            return transactionId;
        } catch (error) {
            console.error('❌ Erro salvando transação:', error);
            return null;
        }
    }
};

// ===== LOGGER =====
const Logger = {
    async paymentConfirmed(paymentData) {
        try {
            if (!client || !client.isReady()) return;
            
            const paymentLogChannel = client.channels.cache.get(CONFIG.PAYMENT_LOG_CHANNEL_ID);
            if (!paymentLogChannel) return;

            const { userId, userTag, product, plan, price, paymentMethod, txid, keyDelivered, discounts, confirmedBy, confirmationType, deliveredKey } = paymentData;
            const isManual = confirmationType === 'manual';
            
            const components = [
                { type: 10, content: `# 💰 PAGAMENTO ${isManual ? 'MANUAL' : 'AUTOMÁTICO'}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Nova transação processada!** Detalhes completos do pagamento confirmado abaixo.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Cliente:** ${userTag}\n**📦 Produto:** ${product} - ${plan}\n**💰 Valor:** ${price}\n**💳 Método:** ${paymentMethod.toUpperCase()}\n**🚀 Entrega:** ${keyDelivered ? '✅ Automática' : '⚙️ Manual'}\n**🆔 Transação:** ${txid || 'N/A'}` }
            ];

            if (discounts && discounts.length > 0) {
                const discountInfo = discounts.map(d => d.description).join(', ');
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: `🏷️ **Descontos Aplicados:** ${discountInfo}` }
                );
            }
            
            if (isManual && confirmedBy) {
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: `👨‍💼 **Confirmado por:** ${confirmedBy}` }
                );
            }

            // Adicionar informação da chave se foi entregue
            if (keyDelivered && deliveredKey) {
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: `**🔑 Key Entregue:** \`${deliveredKey}\`` }
                );
            }

            await paymentLogChannel.send({ 
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }] 
            });
            
            const confirmationType_display = paymentData.confirmationType === 'manual' ? '(MANUAL)' : '(AUTO)';
            console.log(`💰 PAGAMENTO CONFIRMADO ${confirmationType_display}: ${paymentData.userTag} | ${paymentData.product} - ${paymentData.plan} | ${paymentData.price}`);
            
        } catch (error) {
            console.error('Erro enviando log de pagamento confirmado:', error);
        }
    },

    async mixedPaymentConfirmed(paymentData) {
        try {
            if (!client || !client.isReady()) return;
            
            const paymentLogChannel = client.channels.cache.get(CONFIG.PAYMENT_LOG_CHANNEL_ID);
            if (!paymentLogChannel) return;

            const { userId, userTag, product, plan, totalPrice, balanceUsed, pixAmount, paymentMethod, txid, keyDelivered, deliveredKey } = paymentData;

            const components = [
                { type: 10, content: `# 💰 PAGAMENTO MISTO (AUTOMÁTICO)` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Pagamento híbrido processado!** Combinação de saldo interno + PIX confirmada automaticamente.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Cliente:** ${userTag}\n**📦 Produto:** ${product} - ${plan}\n**💰 Total:** R$ ${totalPrice.toFixed(2)}\n**💳 Saldo Usado:** R$ ${balanceUsed.toFixed(2)}\n**💳 PIX Pago:** R$ ${pixAmount.toFixed(2)}\n**💳 Método:** ${paymentMethod}\n**🚀 Entrega:** ${keyDelivered ? '✅ Automática' : '⚙️ Manual'}\n**🆔 Transação:** ${txid || 'N/A'}` }
            ];

            // Adicionar informação da chave se foi entregue
            if (keyDelivered && deliveredKey) {
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: `**🔑 Key Entregue:** \`${deliveredKey}\`` }
                );
            }

            await paymentLogChannel.send({ 
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }] 
            });
            
            console.log(`💰 PAGAMENTO MISTO CONFIRMADO (AUTO): ${userTag} | ${product} - ${plan} | Saldo: R$ ${balanceUsed.toFixed(2)} + PIX: R$ ${pixAmount.toFixed(2)}`);
            
        } catch (error) {
            console.error('Erro enviando log de pagamento misto:', error);
        }
    },

    async customPaymentConfirmed(paymentData) {
        try {
            if (!client || !client.isReady()) return;
            
            const paymentLogChannel = client.channels.cache.get(CONFIG.PAYMENT_LOG_CHANNEL_ID);
            if (!paymentLogChannel) return;

            const { userId, userTag, valor, description, txid, efiTxid, confirmedBy, confirmationType } = paymentData;
            const isManual = confirmationType === 'manual';
            
            const components = [
                { type: 10, content: `# 💰 PAGAMENTO PERSONALIZADO` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Pagamento personalizado processado!** Detalhes da transação confirmada abaixo.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**👤 Cliente:** ${userTag}\n**💰 Valor:** R$ ${valor.toFixed(2)}\n**📋 Descrição:** ${description}\n**💳 Método:** PIX\n**🆔 ID Interno:** ${txid}${efiTxid ? `\n**🆔 ID EFI:** ${efiTxid}` : ''}` }
            ];
            
            if (isManual && confirmedBy) {
                components.push(
                    { type: 14, divider: true, spacing: 1 },
                    { type: 10, content: `👨‍💼 **Confirmado por:** ${confirmedBy}` }
                );
            }

            await paymentLogChannel.send({ 
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }] 
            });
            
        } catch (error) {
            console.error('Erro enviando log de pagamento personalizado:', error);
        }
    },

    async approveAutomatically(channel, userId, keyDelivered) {
        try {
            const user = await client.users.fetch(userId);
            
            const components = [
                { type: 10, content: '#  PIX Confirmado' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**${user.username}**, pagamento confirmado!\n ${keyDelivered ? 'Key enviada via DM' : 'Entrega manual em andamento'}` }
            ];
            
            await channel.send({
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });
            
            setTimeout(async () => {
                try {
                    if (channel && !channel.deleted) {
                        await channel.delete('Pagamento confirmado - fechamento automático');
                    }
                } catch (error) {
                    console.error('Erro fechando canal após pagamento:', error);
                }
            }, 30000);
            
        } catch (error) {
            console.error('Erro aprovação automática PIX:', error);
        }
    }
};

// ===== CART SYSTEM =====
const CartSystem = {
    async createChannel(guild, user, product, subproduct, paymentMethod) {
        const category = guild.channels.cache.get(CONFIG.TICKET_CATEGORY_ID);
        if (!category) throw new Error('Categoria não encontrada');

        const channelName = `cart-${user.username}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { 
                    id: user.id, 
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory
                    ] 
                }
            ]
        });

        console.log(`🛒 Carrinho criado: ${channelName} - ${user.tag} - ${product.titulo}`);

        await this.setupCart(channel, user, product, subproduct, paymentMethod);
        this.scheduleCleanup(channel);
        
        return channel;
    },

    async createCustomPaymentChannel(guild, user, valor, description) {
        const category = guild.channels.cache.get(CONFIG.TICKET_CATEGORY_ID);
        if (!category) throw new Error('Categoria não encontrada');

        const channelName = `payment-${user.username}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { 
                    id: user.id, 
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory
                    ] 
                }
            ]
        });

        console.log(`💰 Canal de pagamento personalizado criado: ${channelName} - ${user.tag} - R$ ${valor.toFixed(2)}`);

        await this.setupCustomPayment(channel, user, valor, description);
        this.scheduleCleanup(channel);
        
        return channel;
    },

    async setupCart(channel, user, product, subproduct, paymentMethod) {
        const brlPrice = parseFloat(subproduct.preco);
        const pricingInfo = await PricingSystem.calculateFinalPrice(brlPrice, user.id);
        const finalBrlPrice = pricingInfo.finalPrice;
        const userBalance = await BalanceSystem.getBalance(user.id);

        // Verificar estoque
        const products = await Products.load();
        const productId = Object.entries(products).find(([id, p]) => p.titulo === product.titulo)?.[0];
        const subproductIndex = product.subprodutos.findIndex(sub => sub.nome === subproduct.nome);
        const stockAvailable = await StockSystem.getAvailableCount(productId, subproductIndex);

        let displayPrice, paymentData = null;

        if (paymentMethod === 'pix') {
            displayPrice = PricingSystem.formatPriceDisplay(pricingInfo);
            
            if (efi && process.env.PIX_KEY && stockAvailable > 0) {
                try {
                    paymentData = await PIX.createCharge(finalBrlPrice, `${product.titulo} - ${subproduct.nome}`);
                    PIX.monitorPayment(
                        paymentData.txid, channel.id, user.id, user.tag, 
                        product.titulo, subproduct.nome, `R$ ${finalBrlPrice.toFixed(2)}`, paymentMethod
                    );
                } catch (error) {
                    console.error('❌ Erro criando PIX:', error);
                    displayPrice += ' (Erro ao gerar PIX)';
                }
            }
        } else {
            const cryptoPrice = Utils.calculateCryptoPrice(finalBrlPrice, paymentMethod);
            displayPrice = PricingSystem.formatPriceDisplay(pricingInfo) + ` (${cryptoPrice})`;
        }
        
        const cartData = {
            user: user,
            product: product,
            subproduct: subproduct,
            paymentMethod: paymentMethod,
            displayPrice: displayPrice,
            stockAvailable: stockAvailable,
            pricingInfo: pricingInfo,
            paymentData: paymentData,
            useBalance: false,
            productId: productId,
            subproductIndex: subproductIndex
        };
        
        global.cartDataMap = global.cartDataMap || new Map();
        global.cartDataMap.set(channel.id, cartData);
        
        await channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildCart(user, product, subproduct, paymentMethod, displayPrice, stockAvailable, pricingInfo, channel.id, false, userBalance)]
        });

        if (stockAvailable > 0) {
            await this.sendPaymentInstructions(channel, paymentMethod, paymentData, finalBrlPrice);
        } else {
            const embed = new EmbedBuilder()
                .setTitle('❌ Produto Esgotado')
                .setDescription('Este produto está temporariamente fora de estoque. Nossa equipe foi notificada.')
                .addFields(
                    { name: 'Produto', value: product.titulo },
                    { name: 'Plano', value: subproduct.nome }
                )
                .setColor('#ff9900');
            await channel.send({ embeds: [embed] });
        }
    },

    async setupCustomPayment(channel, user, valor, description) {
        if (!efi || !process.env.PIX_KEY) {
            const embed = new EmbedBuilder()
                .setTitle('❌ PIX Indisponível')
                .setDescription('Sistema PIX não configurado. Entre em contato com a equipe.')
                .setColor('#ff0000');
            await channel.send({ embeds: [embed] });
            return;
        }

        try {
            const payment = await CustomPaymentSystem.create(user.id, user.tag, valor, description, channel.id);
            
            const pixData = await PIX.createCharge(valor, description);
            
            const payments = await CustomPaymentSystem.load();
            const paymentIndex = payments.findIndex(p => p.id === payment.id);
            if (paymentIndex !== -1) {
                payments[paymentIndex].efiTxid = pixData.txid;
                payments[paymentIndex].pixCode = pixData.pixCopiaECola;
                await CustomPaymentSystem.save(payments);
                
                payment.efiTxid = pixData.txid;
                payment.pixCode = pixData.pixCopiaECola;
            }
            
            const qrFileName = `custom_pix_${payment.id}_${Date.now()}.png`;
            const qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
            const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
            
            await channel.send({
                flags: ['IsComponentsV2'],
                components: [ComponentBuilder.buildCustomPixPayment(valor, payment.id, description, qrFileName, payment.expiresAt)],
                files: [qrAttachment]
            });

            PIX.monitorCustomPayment(payment);
            
        } catch (error) {
            console.error('❌ Erro configurando pagamento personalizado:', error);
            
            const embed = new EmbedBuilder()
                .setTitle('❌ Erro ao Gerar Pagamento')
                .setDescription(`Erro: ${error.message}`)
                .setColor('#ff0000');
            await channel.send({ embeds: [embed] });
        }
    },

    async sendPaymentInstructions(channel, paymentMethod, paymentData, brlPrice) {
        if (paymentMethod === 'pix' && paymentData) {
            await this.sendPixInstructions(channel, paymentData);
        } else if (paymentMethod === 'bitcoin' || paymentMethod === 'litecoin') {
            await this.sendCryptoInstructions(channel, paymentMethod, brlPrice);
        } else {
            const embed = new EmbedBuilder()
                .setTitle(`💳 ${paymentMethod.toUpperCase()}`)
                .setDescription('Entre em contato com nossa equipe para finalizar o pagamento')
                .addFields(
                    { name: 'Valor', value: `R$ ${brlPrice.toFixed(2)}` },
                    { name: 'ID', value: `\`${channel.name}\`` }
                )
                .setColor('#0099ff');
            await channel.send({ embeds: [embed] });
        }
    },

    async sendPixInstructions(channel, paymentData) {
        try {
            const qrFileName = `pix_qr_${paymentData.txid}_${Date.now()}.png`;
            const qrFilePath = await PIX.generateQRCode(paymentData.pixCopiaECola, qrFileName);
            const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
            
            await channel.send({ 
                flags: ['IsComponentsV2'],
                components: [ComponentBuilder.buildPixInstructions(paymentData, qrFileName)],
                files: [qrAttachment] 
            });
        } catch (error) {
            console.error('❌ Erro gerando QR Code PIX:', error);
            await channel.send({
                flags: ['IsComponentsV2'],
                components: [ComponentBuilder.buildPixInstructions(paymentData, null)]
            });
        }
    },

    async sendCryptoInstructions(channel, paymentMethod, brlPrice) {
        const walletAddress = Utils.getWalletAddress(paymentMethod);
        const cryptoAmount = Utils.calculateCryptoPrice(brlPrice, paymentMethod);
        
        await channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildCryptoInstructions(paymentMethod, brlPrice, walletAddress, cryptoAmount)]
        });
    },

    scheduleCleanup(channel) {
        setTimeout(async () => {
            try {
                if (channel && !channel.deleted) {
                    const embed = new EmbedBuilder()
                        .setTitle('⏰ Canal Expirando')
                        .setDescription('Este canal expirará em 30 segundos.')
                        .setColor('#ffaa00');
                    await channel.send({ embeds: [embed] });
                    
                    setTimeout(async () => {
                        try {
                            if (channel && !channel.deleted) {
                                console.log(`🗑️ Canal fechado por timeout: ${channel.name}`);
                                await channel.delete('Canal expirado');
                            }
                        } catch (error) {
                            console.error('Erro fechando canal expirado:', error);
                        }
                    }, 30000);
                }
            } catch (error) {
                console.error('Erro no aviso de expiração:', error);
            }
        }, CONFIG.PAYMENT_TIMEOUT - 30000);
    }
};

// ===== COMMANDS =====
const commands = [
    { name: 'setproducts', description: 'Configurar loja', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'createproduct', description: 'Criar produto', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'listproducts', description: 'Listar produtos', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'addstock', description: 'Adicionar estoque (interface)', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'removestock', description: 'Remover estoque', options: [
        { name: 'product_id', description: 'ID do produto', type: 3, required: true },
        { name: 'subproduct_index', description: 'Índice do plano (0, 1, 2...)', type: 4, required: true },
        { name: 'quantity', description: 'Quantidade a remover', type: 4, required: true, min_value: 1 }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'checkstock', description: 'Verificar estoque', options: [
        { name: 'product_id', description: 'ID do produto (opcional)', type: 3, required: false }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'clearstock', description: 'Limpar estoque', options: [
        { name: 'product_id', description: 'ID do produto', type: 3, required: true },
        { name: 'subproduct_index', description: 'Índice do plano (opcional)', type: 4, required: false }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'addreseller', description: 'Adicionar reseller', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'removereseller', description: 'Remover reseller', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'setglobaldiscount', description: 'Definir desconto global', options: [
        { name: 'percentage', description: 'Porcentagem (0-100)', type: 4, required: true, min_value: 0, max_value: 100 }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'removeglobaldiscount', description: 'Remover desconto global', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'confirmpayment', description: 'Confirmar pagamento manual', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true },
        { name: 'product', description: 'Produto', type: 3, required: true },
        { name: 'plan', description: 'Plano', type: 3, required: true },
        { name: 'price', description: 'Valor', type: 3, required: true },
        { name: 'method', description: 'Método', type: 3, required: true },
        { name: 'tx_id', description: 'ID transação', type: 3, required: false }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'addsaldo', description: 'Adicionar saldo', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true },
        { name: 'amount', description: 'Valor BRL', type: 10, required: true, min_value: 0.01 }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'removesaldo', description: 'Remover saldo', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true },
        { name: 'amount', description: 'Valor BRL', type: 10, required: true, min_value: 0.01 }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'setsaldo', description: 'Definir saldo', options: [
        { name: 'user', description: 'Usuário', type: 6, required: true },
        { name: 'amount', description: 'Valor BRL', type: 10, required: true, min_value: 0 }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'checksaldo', description: 'Verificar saldo', options: [
        { name: 'user', description: 'Usuário (opcional)', type: 6, required: false }
    ] },
    { name: 'topsaldo', description: 'Ranking de saldos', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'gerarpagamento', description: 'Gerar pagamento PIX personalizado', options: [
        { name: 'valor', description: 'Valor em reais (R$)', type: 10, required: true, min_value: 1.00 },
        { name: 'user', description: 'Usuário para receber o pagamento', type: 6, required: true },
        { name: 'description', description: 'Descrição do pagamento', type: 3, required: false }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'confirmpix', description: 'Confirmar pagamento PIX manualmente', options: [
        { name: 'transaction_id', description: 'ID da transação', type: 3, required: true }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'listpayments', description: 'Listar pagamentos ativos', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'stats', description: '📊 Dashboard completo de vendas e estatísticas', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'analytics', description: '📈 Análise detalhada de performance', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'export', description: '📋 Exportar dados para análise', options: [
        { name: 'type', description: 'Tipo de dados', type: 3, required: true, choices: [
            { name: 'Transações', value: 'transactions' },
            { name: 'Clientes', value: 'customers' },
            { name: 'Produtos', value: 'products' },
            { name: 'Analytics', value: 'analytics' }
        ]}
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'limpar', description: 'Limpa as mensagens do canal', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'system', description: '🔧 Informações do sistema', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'sorteio', description: 'Criar um sorteio avançado', options: [
        { name: 'premio', description: 'Prêmio do sorteio', type: 3, required: true },
        { name: 'ganhadores', description: 'Número de ganhadores', type: 4, required: true, min_value: 1, max_value: 10 },
        { name: 'duracao', description: 'Duração (ex: 1d, 2h, 30m)', type: 3, required: true }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'setembed', description: 'Criar embed de um produto específico', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'editarproduto', description: 'Editar produto existente', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'updates', description: 'Enviar embed de atualizações no chat', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'pix', description: 'Gerar pagamento PIX personalizado', options: [
        { name: 'valor', description: 'Valor em reais (R$)', type: 10, required: true, min_value: 0.01 },
        { name: 'usuario', description: 'Usuário para receber o pagamento', type: 6, required: true },
        { name: 'descricao', description: 'Descrição do pagamento', type: 3, required: false }
    ], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'ticket', description: 'Criar painel de tickets no chat', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
];

// ===== EVENTS =====
client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    
    try {
        await Utils.ensureDataDir();
        await client.application.commands.set(commands);
        console.log('✅ Comandos registrados');
        
        const dataFiles = [
            CONFIG.PRODUCTS_FILE, 
            CONFIG.STOCK_FILE,
            CONFIG.RESELLERS_FILE, 
            CONFIG.TRANSACTIONS_FILE, 
            CONFIG.GLOBAL_DISCOUNT_FILE, 
            CONFIG.BALANCE_FILE, 
            CONFIG.BALANCE_TRANSACTIONS_FILE,
            CONFIG.CUSTOM_PAYMENTS_FILE,
            CONFIG.ANALYTICS_FILE,
            CONFIG.GIVEAWAYS_FILE,
            CONFIG.TICKETS_FILE
        ];
        
        for (const file of dataFiles) {
            const defaultValue = file.includes('transactions') || file.includes('custom_payments') ? [] : 
                                 file.includes('global_discount') ? { active: false, percentage: 0 } :
                                 file.includes('analytics') ? {
                                     totalSales: 0,
                                     totalRevenue: 0,
                                     totalCustomers: 0,
                                     dailyStats: {},
                                     productStats: {},
                                     customerStats: {},
                                     paymentMethodStats: {},
                                     monthlyRevenue: {},
                                     lastUpdated: new Date().toISOString()
                                 } : {};
            await Utils.loadJSON(file, defaultValue);
        }
        
        const globalDiscountActive = await GlobalDiscount.isActive();
        console.log(`✅ Sistema iniciado - Desconto global: ${globalDiscountActive ? `${(await GlobalDiscount.getPercentage() * 100).toFixed(0)}% ativo` : 'inativo'}`);
        
        setInterval(async () => {
            await CustomPaymentSystem.cleanExpired();
        }, 300000);
        
    } catch (error) {
        console.error('❌ Erro na inicialização:', error);
    }
});



client.on('interactionCreate', async interaction => {
    // Rate limiting mais inteligente
    if (!Utils.checkRateLimit(interaction.user.id)) {
        try {
            await Utils.safeReply(interaction, { 
                flags: ['IsComponentsV2'],
                components: [{
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: "⚠️ **Muitas interações!**\n\nAguarde alguns segundos antes de tentar novamente."
                        }
                    ]
                }],
                ephemeral: true 
            });
        } catch (error) {
            console.error('❌ Erro no rate limit:', error);
        }
        return;
    }

    try {
        if (interaction.isChatInputCommand()) {
            await handleCommand(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModal(interaction);
        } else if (interaction.isButton()) {
            if (interaction.customId.startsWith('giveaway_join_')) {
                const id = interaction.customId.replace('giveaway_join_', '');
                const g = await GiveawaySystem.get(id);
                if (!g || g.status !== 'active') {
                    return await Utils.safeReply(interaction, { 
                        flags: ['IsComponentsV2'],
                        components: [{
                            type: 17,
                            accent_color: null,
                            spoiler: false,
                            components: [
                                {
                                    type: 10,
                                    content: "❌ **Sorteio não encontrado ou já finalizado.**"
                                }
                            ]
                        }],
                        ephemeral: true 
                    });
                }
                
                // Verificar se já participou
                if (g.participants.find(p => p.userId === interaction.user.id)) {
                    return await Utils.safeReply(interaction, { 
                        flags: ['IsComponentsV2'],
                        components: [{
                            type: 17,
                            accent_color: null,
                            spoiler: false,
                            components: [
                                {
                                    type: 10,
                                    content: "❌ **Você já está participando deste sorteio!**"
                                }
                            ]
                        }],
                        ephemeral: true 
                    });
                }
                
                // Adicionar participante
                await GiveawaySystem.join(id, interaction.user.id, interaction.user.tag);
                
                // Atualizar embed com novo participante
                const updated = await GiveawaySystem.get(id);
                const updatedComponents = ComponentBuilder.buildGiveaway(updated, false);
                
                console.log(`🎉 ${interaction.user.tag} participou do sorteio ${id}. Total: ${updated.participants.length}`);
                
                // Atualizar embed com novo participante
                await interaction.update({ 
                    flags: ['IsComponentsV2'], 
                    components: updatedComponents
                });
                
                // Enviar confirmação separadamente
                await interaction.followUp({ 
                    flags: ['IsComponentsV2'],
                    components: [{
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 10,
                                content: `🎉 **Parabéns! Você se inscreveu no sorteio!**\n\n📦 **Prêmio:** ${g.prize}\n⏰ **Termina:** <t:${Math.floor(g.endTime/1000)}:R>\n\n🍀 **Boa sorte!**`
                            }
                        ]
                    }],
                    ephemeral: true 
                });
            } else {
                await handleButton(interaction);
            }
        }
    } catch (error) {
        console.error('❌ Erro na interação:', error);
        
        // Tratar erro de interação expirada
        if (error.code === 10062) {
            console.log('⚠️ Interação expirada, ignorando...');
            return;
        }
        
        try {
            await Utils.safeReply(interaction, { 
                flags: ['IsComponentsV2'],
                components: [{
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: "❌ **Erro interno.**\n\nTente novamente em alguns segundos."
                        }
                    ]
                }],
                ephemeral: true 
            });
        } catch (replyError) {
            console.error('❌ Erro ao enviar mensagem de erro:', replyError);
        }
    }
});

// Função para finalizar sorteio automaticamente
async function endGiveaway(id, channel) {
    const ended = await GiveawaySystem.end(id);
    if (!ended) return;
    try {
        const msg = await channel.messages.fetch(ended.messageId).catch(() => null);
        if (msg) {
            const endedComponents = ComponentBuilder.buildGiveaway(ended, true);
            await msg.edit({ flags: ['IsComponentsV2'], components: endedComponents });
        }
        
        // Notificar vencedores
        if (ended.winners.length > 0) {
            const winnersText = ended.winners.map((winner, index) => `${index + 1}. <@${winner.userId}>`).join('\n');
            const notificationEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 9,
                        accessory: {
                            type: 2,
                            style: 5,
                            label: "Nosso site!",
                            emoji: null,
                            disabled: false,
                            url: "https://rootunk.store"
                        },
                        components: [
                            {
                                type: 10,
                                content: `# ⚠️ Aviso — Sorteio Finalizado`
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: `🎉 Parabéns aos grandes vencedores do sorteio Root@Unk!\n\n🏆 Vencedores:\n${winnersText}\n\n📦 Prêmio: ${ended.prize}\n🕒 Resgate: Os vencedores devem abrir um ticket em até 24h para receber suas keys.\n\n⚠️ Caso o resgate não seja realizado dentro do prazo, o prêmio poderá ser repassado a outro participante.`
                    }
                ]
            };
            
            await channel.send({
                flags: ['IsComponentsV2'],
                components: [notificationEmbed]
            });
            
            // Enviar mensagem privada para cada vencedor
            for (const winner of ended.winners) {
                try {
                    const user = await client.users.fetch(winner.userId);
                    const winnersText = ended.winners.map((w, index) => `${index + 1}. <@${w.userId}>`).join('\n');
                    
                    const privateEmbed = {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 9,
                                accessory: {
                                    type: 2,
                                    style: 5,
                                    label: "Nosso site!",
                                    emoji: null,
                                    disabled: false,
                                    url: "https://rootunk.store"
                                },
                                components: [
                                    {
                                        type: 10,
                                        content: `# ⚠️ Aviso — Sorteio Finalizado (@${winner.userTag})`
                                    }
                                ]
                            },
                            {
                                type: 10,
                                content: `🎉 Parabéns! Você foi o grande vencedor do sorteio Root@Unk!\n\n📦 Prêmio: ${ended.prize}\n🕒 Resgate: Abra um ticket em até 24h para receber sua key.\n\n⚠️ Caso o resgate não seja realizado dentro do prazo, o prêmio será repassado a outro participante.`
                            }
                        ]
                    };
                    
                    await user.send({
                        flags: ['IsComponentsV2'],
                        components: [privateEmbed]
                    });
                    
                    console.log(`📬 Notificação enviada para vencedor: ${winner.userTag}`);
                } catch (error) {
                    console.error(`❌ Erro enviando notificação para ${winner.userTag}:`, error);
                }
            }
        } else {
            await channel.send({
                flags: ['IsComponentsV2'],
                components: [{
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: `🏆 **SORTEIO ENCERRADO!**\n\n📦 **Prêmio:** ${ended.prize}\n📊 **Total de participantes:** 0\n\nNenhum participante se inscreveu no sorteio.`
                        }
                    ]
                }]
            });
        }
    } catch (e) { 
        console.error('Erro ao finalizar sorteio:', e); 
    }
}

// ===== HANDLERS =====
async function handleCommand(interaction) {
    switch (interaction.commandName) {
        case 'setproducts':
            await cmdSetProducts(interaction);
            break;
        case 'createproduct':
            await cmdCreateProduct(interaction);
            break;
        case 'listproducts':
            await cmdListProducts(interaction);
            break;
        case 'addstock':
            await cmdAddStock(interaction);
            break;
        case 'removestock':
            await cmdRemoveStock(interaction);
            break;
        case 'checkstock':
            await cmdCheckStock(interaction);
            break;
        case 'clearstock':
            await cmdClearStock(interaction);
            break;
        case 'addreseller':
            await cmdAddReseller(interaction);
            break;
        case 'removereseller':
            await cmdRemoveReseller(interaction);
            break;
        case 'setglobaldiscount':
            await cmdSetGlobalDiscount(interaction);
            break;
        case 'removeglobaldiscount':
            await cmdRemoveGlobalDiscount(interaction);
            break;
        case 'confirmpayment':
            await cmdConfirmPayment(interaction);
            break;
        case 'addsaldo':
            await cmdAddSaldo(interaction);
            break;
        case 'removesaldo':
            await cmdRemoveSaldo(interaction);
            break;
        case 'setsaldo':
            await cmdSetSaldo(interaction);
            break;
        case 'checksaldo':
            await cmdCheckSaldo(interaction);
            break;
        case 'topsaldo':
            await cmdTopSaldo(interaction);
            break;
        case 'gerarpagamento':
            await cmdGerarPagamento(interaction);
            break;
        case 'confirmpix':
            await cmdConfirmPix(interaction);
            break;
        case 'listpayments':
            await cmdListPayments(interaction);
            break;
        case 'stats':
            await cmdStats(interaction);
            break;
        case 'analytics':
            await cmdAnalytics(interaction);
            break;
        case 'export':
            await cmdExport(interaction);
            break;
        case 'limpar':
            await cmdLimpar(interaction);
            break;
        case 'system':
            await cmdSystem(interaction);
            break;
        case 'sorteio':
            await cmdSorteio(interaction);
            break;
        case 'setembed':
            await cmdSetEmbed(interaction);
            break;
        case 'editarproduto':
            await cmdEditarProduto(interaction);
            break;
        case 'updates':
            await cmdUpdates(interaction);
            break;
        case 'pix':
            await cmdPix(interaction);
            break;
        case 'ticket':
            await cmdTicket(interaction);
            break;
        default:
            await Utils.safeReply(interaction, { content: '❌ Comando não reconhecido.', ephemeral: true });
    }
}

// ===== COMMAND HANDLERS =====

async function cmdSystem(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await Utils.safeReply(interaction, { content: '❌ Você não tem permissão para usar este comando.', ephemeral: true });
        return;
    }
    
    try {
        // Carregar dados do sistema
        const products = await Products.load();
        const stock = await StockSystem.getAllStock();
        const globalDiscount = await GlobalDiscount.getInfo();
        const analytics = await AnalyticsSystem.getSummary();
        const resellers = await Utils.loadJSON(CONFIG.RESELLERS_FILE, {});
        
        // Calcular estatísticas
        const totalProducts = Object.keys(products).length;
        const totalStock = Object.values(stock).reduce((sum, productStock) => {
            return sum + Object.values(productStock).reduce((subSum, subStock) => subSum + subStock.length, 0);
        }, 0);
        const totalResellers = Object.keys(resellers).length;
        
        // Criar embed v2
        const embed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 11,
                        media: {
                            url: "https://images-ext-1.discordapp.net/external/V-hG2MFW-U4dAkqrBtsFReHTVrUi3tpzHYayuajbi78/https/images-ext-1.discordapp.net/external/hHIebZTkU1UsFlwzZVf5sp1lqOtCWBusZQBBXGgRvVE/https/images-ext-1.discordapp.net/external/5GOpvjsg_BQZqghg9SMQgRR12k2D9_g02WhZ8HWwht0/https/images-ext-1.discordapp.net/external/3CVXgrJn9pjer_cuo5Z2S9r7ZxIy0fI_m1wyUSMDUgU/https/cdn.discordapp.com/icons/1197909142208253972/a_ae43a6c185521b03f73a5406304dc940.gif"
                        },
                        description: null,
                        spoiler: false
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🔑 KEY: `rootunk.store`\nAcesse o link abaixo, insira sua key de ativação no campo indicado e finalize o processo:"
                        }
                    ]
                },
                {
                    type: 10,
                    content: "🖼️ Após ativar, envie um print da tela de confirmação aqui no chat para darmos continuidade.\n💡 Dica: Se tiver dúvidas, acesse a aba Tutoriais no site e siga o passo a passo completo."
                },
                {
                    type: 13,
                    file: {
                        url: "attachment://Informations.exe"
                    },
                    spoiler: false
                }
            ]
        };
        
        // Criar arquivo Informations.exe como buffer
        const fileContent = `=== ROOT@UNK STORE - VERIFICAÇÃO DE DRIVERS E SISTEMA ===

KEY DE ATIVAÇÃO: rootunk.store

Este arquivo contém informações para verificação de drivers e sistema.

INSTRUÇÕES:
1. Execute este arquivo para verificar drivers
2. Insira a key: rootunk.store
3. Aguarde a verificação completa
4. Envie o print da tela de confirmação

STATUS: Sistema de verificação ativo
VERSÃO: 1.0
DATA: 2024

=== FIM DO ARQUIVO ===`;

        const attachment = {
            attachment: Buffer.from(fileContent, 'utf8'),
            name: 'Informations.exe'
        };
        
        await interaction.reply({
            flags: ['IsComponentsV2'],
            components: [embed],
            files: [attachment]
        });
        
    } catch (error) {
        console.error('❌ Erro ao carregar informações do sistema:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdLimpar(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await Utils.safeReply(interaction, { content: '❌ Você não tem permissão para usar este comando.', ephemeral: true });
        return;
    }
    try {
        await Utils.safeReply(interaction, { content: '🧹 Limpando mensagens...', ephemeral: true });
        const channel = interaction.channel;
        const messages = await channel.messages.fetch({ limit: 100 });
        const deleted = await channel.bulkDelete(messages, true);
        await channel.send({ content: `✅ ${deleted.size} mensagens apagadas por ${interaction.user}.` });
    } catch (error) {
        console.error('Erro ao limpar canal:', error);
        await interaction.editReply({ content: `❌ Erro ao limpar o canal: ${error.message}` });
    }
}

async function cmdSorteio(interaction) {
    try {
        const prize = interaction.options.getString('premio');
        const winners = interaction.options.getInteger('ganhadores');
        const durationStr = interaction.options.getString('duracao');
        
        // Validar duração
        let duration;
        try {
            duration = Utils.parseDuration(durationStr);
        } catch (error) {
            await Utils.safeReply(interaction, { 
                content: `❌ ${error.message}`, 
                ephemeral: true 
            });
            return;
        }
        
        const host = interaction.user.id;
        const hostTag = interaction.user.tag;
        const channelId = interaction.channel.id;
        const guildId = interaction.guild.id;
        
        const giveaway = await GiveawaySystem.create({ 
            prize, 
            winners, 
            duration, 
            host, 
            hostTag, 
            channelId, 
            guildId 
        });
        
        // Responder primeiro para não dar timeout
        await Utils.safeReply(interaction, { 
            content: `✅ Sorteio criado!\n📦 Prêmio: ${prize}\n🏆 Ganhadores: ${winners}\n⏰ Duração: ${durationStr}`, 
            ephemeral: true 
        });
        
        const giveawayComponents = ComponentBuilder.buildGiveaway(giveaway, false);
        const msg = await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: giveawayComponents
        });
        
        // Salva o messageId
        giveaway.messageId = msg.id;
        const giveaways = await GiveawaySystem.load();
        giveaways[giveaway.id] = giveaway;
        await GiveawaySystem.save(giveaways);
        
        // Agenda finalização automática
        setTimeout(async () => {
            const g = await GiveawaySystem.get(giveaway.id);
            if (g && g.status === 'active') {
                await endGiveaway(giveaway.id, msg.channel);
            }
        }, duration + 2000);
        
    } catch (error) {
        console.error('❌ Erro ao criar sorteio:', error);
        await Utils.safeReply(interaction, { 
            content: `❌ Erro ao criar sorteio: ${error.message}`, 
            ephemeral: true 
        });
    }
}

async function cmdSetEmbed(interaction) {
    try {
        await Utils.safeReply(interaction, { content: '🔄 Carregando produtos...', ephemeral: true });
        
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const productIds = Object.keys(products);
        
        if (productIds.length === 0) {
            await interaction.editReply({ content: '❌ Nenhum produto encontrado.' });
            return;
        }
        
        // Criar opções para o select
        const productOptions = productIds.map(productId => {
            const product = products[productId];
            return {
                label: product.titulo,
                value: productId,
                description: `${product.subprodutos.length} planos - R$ ${product.subprodutos[0]?.preco || 0}`
            };
        });
        
        // Enviar embed com select
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildSetEmbedSelect(productOptions)]
        });
        
        await interaction.editReply({ content: '✅ Selecione o produto para criar a embed!' });
        
    } catch (error) {
        console.error('❌ Erro ao carregar produtos:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdEditarProduto(interaction) {
    try {
        await Utils.safeReply(interaction, { content: '🔄 Carregando produtos...', ephemeral: true });
        
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const productIds = Object.keys(products);
        
        if (productIds.length === 0) {
            await interaction.editReply({ content: '❌ Nenhum produto encontrado.' });
            return;
        }
        
        // Criar opções para o select
        const productOptions = productIds.map(productId => {
            const product = products[productId];
            return {
                label: product.titulo,
                value: productId,
                description: `${product.subprodutos.length} planos - R$ ${product.subprodutos[0]?.preco || 0}`
            };
        });
        
        // Enviar embed com select
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildEditProductSelect(productOptions)]
        });
        
        await interaction.editReply({ content: '✅ Selecione o produto que deseja editar!' });
        
    } catch (error) {
        console.error('❌ Erro ao carregar produtos:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdStats(interaction) {
    try {
        await Utils.safeReply(interaction, { content: '📊 Carregando dashboard...', ephemeral: true });
        
        const summary = await AnalyticsSystem.getSummary();
        
        await interaction.editReply({
            content: '',
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStatsDashboard(summary)]
        });
        
    } catch (error) {
        console.error('❌ Erro carregando stats:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdAnalytics(interaction) {
    try {
        await Utils.safeReply(interaction, { content: '📈 Gerando relatório analítico...', ephemeral: true });
        
        const summary = await AnalyticsSystem.getSummary();
        const dailyStats = await AnalyticsSystem.getDailyStats(30);
        const topProducts = await AnalyticsSystem.getTopProducts(5);
        const topCustomers = await AnalyticsSystem.getTopCustomers(5);
        const paymentStats = await AnalyticsSystem.getPaymentMethodStats();
        
        // Calcular algumas métricas avançadas
        const last7Days = dailyStats.slice(-7);
        const weekRevenue = last7Days.reduce((sum, day) => sum + day.revenue, 0);
        const weekSales = last7Days.reduce((sum, day) => sum + day.sales, 0);
        
        const last30Days = dailyStats;
        const monthRevenue = last30Days.reduce((sum, day) => sum + day.revenue, 0);
        const monthSales = last30Days.reduce((sum, day) => sum + day.sales, 0);
        
        const avgDailyRevenue = monthRevenue / 30;
        const conversionRate = summary.totalCustomers > 0 ? (summary.totalSales / summary.totalCustomers * 100) : 0;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Relatório Analítico Avançado')
            .setDescription('**Análise completa de performance da loja**')
            .setColor('#0099ff')
            .addFields(
                {
                    name: '💰 Métricas Financeiras',
                    value: `• Receita total: R$ ${summary.totalRevenue.toFixed(2)}\n• Receita (7 dias): R$ ${weekRevenue.toFixed(2)}\n• Receita (30 dias): R$ ${monthRevenue.toFixed(2)}\n• Média diária: R$ ${avgDailyRevenue.toFixed(2)}\n• Ticket médio: R$ ${summary.averageOrderValue.toFixed(2)}`,
                    inline: true
                },
                {
                    name: '🛍️ Métricas de Vendas',
                    value: `• Total de vendas: ${summary.totalSales}\n• Vendas (7 dias): ${weekSales}\n• Vendas (30 dias): ${monthSales}\n• Clientes únicos: ${summary.totalCustomers}\n• Taxa conversão: ${conversionRate.toFixed(1)}%`,
                    inline: true
                },
                {
                    name: '📈 Performance Hoje',
                    value: `• Vendas: ${summary.todaySales}\n• Receita: R$ ${summary.todayRevenue.toFixed(2)}\n• Clientes: ${summary.todayCustomers}\n• Crescimento: ${summary.monthlyGrowth.toFixed(1)}%`,
                    inline: true
                }
            );
        
        if (topProducts.length > 0) {
            const topProductsText = topProducts.slice(0, 3).map((p, i) => 
                `${i + 1}º ${p.product} (R$ ${p.revenue.toFixed(2)})`
            ).join('\n');
            embed.addFields({ name: '🏆 Top 3 Produtos', value: topProductsText, inline: true });
        }
        
        if (paymentStats.length > 0) {
            const paymentText = paymentStats.slice(0, 3).map(p => 
                `${Utils.getPaymentDisplay(p.method)}: ${((p.revenue / summary.totalRevenue) * 100).toFixed(1)}%`
            ).join('\n');
            embed.addFields({ name: '💳 Métodos Populares', value: paymentText, inline: true });
        }
        
        if (topCustomers.length > 0) {
            const customerText = topCustomers.slice(0, 3).map((c, i) => 
                `${i + 1}º ${c.username} (R$ ${c.totalSpent.toFixed(2)})`
            ).join('\n');
            embed.addFields({ name: '👑 Top 3 Clientes', value: customerText, inline: true });
        }
        
        embed.setTimestamp()
            .setFooter({ text: 'Root@Unk Analytics • Atualizado' });
        
        await interaction.editReply({ embeds: [embed] });
        
    } catch (error) {
        console.error('❌ Erro gerando analytics:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdExport(interaction) {
    const exportType = interaction.options.getString('type');
    
    try {
        await Utils.safeReply(interaction, { content: '📋 Preparando exportação...', ephemeral: true });
        
        let data, filename, description;
        
        switch (exportType) {
            case 'transactions':
                data = await Utils.loadJSON(CONFIG.TRANSACTIONS_FILE, []);
                filename = `transactions_${new Date().toISOString().split('T')[0]}.json`;
                description = 'Todas as transações registradas';
                break;
                
            case 'customers':
                const analytics = await AnalyticsSystem.load();
                data = analytics.customerStats;
                filename = `customers_${new Date().toISOString().split('T')[0]}.json`;
                description = 'Dados completos dos clientes';
                break;
                
            case 'products':
                const products = await Products.load();
                const stock = await StockSystem.getAllStock();
                data = { products, stock };
                filename = `products_${new Date().toISOString().split('T')[0]}.json`;
                description = 'Produtos e estoque atual';
                break;
                
            case 'analytics':
                data = await AnalyticsSystem.load();
                filename = `analytics_${new Date().toISOString().split('T')[0]}.json`;
                description = 'Dados completos de analytics';
                break;
                
            default:
                throw new Error('Tipo de exportação inválido');
        }
        
        // Criar arquivo temporário
        const tempDir = path.join(__dirname, 'temp');
        const filePath = path.join(tempDir, filename);
        
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        
        const attachment = new AttachmentBuilder(filePath, { name: filename });
        
        const embed = new EmbedBuilder()
            .setTitle('📋 Exportação Concluída')
            .setDescription(`**${description}**`)
            .addFields(
                { name: 'Arquivo', value: filename },
                { name: 'Registros', value: Array.isArray(data) ? data.length.toString() : Object.keys(data).length.toString() },
                { name: 'Data', value: new Date().toLocaleString('pt-BR') }
            )
            .setColor('#00ff00');
        
        await interaction.editReply({
            embeds: [embed],
            files: [attachment]
        });
        
        // Cleanup
        Utils.cleanupTempFile(filePath, 60000); // 1 minuto
        
    } catch (error) {
        console.error('❌ Erro na exportação:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

// ===== TODOS OS OUTROS COMMAND HANDLERS ORIGINAIS =====

async function cmdSetProducts(interaction) {
    // Simplesmente criar a embed da loja com o botão "Compre Aqui"
    const storeContainer = ComponentBuilder.buildStore();

    await Utils.safeReply(interaction, { content: '✅ Loja configurada' });
    await interaction.channel.send({ flags: ['IsComponentsV2'], components: [storeContainer] });
}

async function cmdCreateProduct(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('create_product')
        .setTitle('🆕 Criar Produto');

    const inputs = [
        new TextInputBuilder().setCustomId('title').setLabel('Título').setStyle(TextInputStyle.Short).setRequired(true),
        new TextInputBuilder().setCustomId('description').setLabel('Descrição').setStyle(TextInputStyle.Paragraph).setRequired(true),
        new TextInputBuilder().setCustomId('subproducts').setLabel('Planos (nome:preço_BRL)').setStyle(TextInputStyle.Paragraph).setRequired(true)
    ];

    inputs.forEach(input => modal.addComponents(new ActionRowBuilder().addComponents(input)));
    await interaction.showModal(modal);
}

async function cmdListProducts(interaction) {
    const products = await Products.load();
    const stock = await StockSystem.getAllStock();
    
    if (Object.keys(products).length === 0) {
        await Utils.safeReply(interaction, { content: '📭 Nenhum produto encontrado.', ephemeral: true });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('📋 Produtos')
        .setDescription(`Total: ${Object.keys(products).length}`)
        .setColor('#0099ff');

    for (const [id, product] of Object.entries(products).slice(0, 10)) {
        let stockInfo = '';
        if (stock[id]) {
            const totalStock = Object.values(stock[id]).reduce((sum, keys) => sum + keys.length, 0);
            stockInfo = `📦 ${totalStock} keys`;
        } else {
            stockInfo = '📦 0 keys';
        }
        
        const salesInfo = `${product.sales_count || 0} vendas | R$ ${(product.total_revenue || 0).toFixed(2)}`;
        
        embed.addFields({
            name: `${product.titulo}`,
            value: `ID: \`${id}\`\n${stockInfo}\n${salesInfo}`,
            inline: true
        });
    }

    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function cmdAddStock(interaction) {
    const products = await Products.load();
    
    if (Object.keys(products).length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Nenhum produto disponível. Crie produtos primeiro com `/createproduct`.', ephemeral: true });
        return;
    }

    const stockInterface = ComponentBuilder.buildStockInterface();

    await Utils.safeReply(interaction, { 
        flags: ['IsComponentsV2'],
        components: [stockInterface]
    });
}

async function cmdRemoveStock(interaction) {
    const productId = interaction.options.getString('product_id');
    const subproductIndex = interaction.options.getInteger('subproduct_index');
    const quantity = interaction.options.getInteger('quantity');
    
    const products = await Products.load();
    
    if (!products[productId]) {
        await Utils.safeReply(interaction, { content: `❌ Produto \`${productId}\` não encontrado.`, ephemeral: true });
        return;
    }
    
    const product = products[productId];
    if (!product.subprodutos || !product.subprodutos[subproductIndex]) {
        await Utils.safeReply(interaction, { content: `❌ Plano com índice \`${subproductIndex}\` não encontrado.`, ephemeral: true });
        return;
    }
    
    try {
        const removedKeys = await StockSystem.removeStock(productId, subproductIndex, quantity);
        const remainingStock = await StockSystem.getAvailableCount(productId, subproductIndex);
        
        await Utils.safeReply(interaction, {
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStockRemoved(product.titulo, product.subprodutos[subproductIndex].nome, quantity, remainingStock, removedKeys)]
        });
        
        console.log(`➖ Estoque removido via comando: ${product.titulo} - ${product.subprodutos[subproductIndex].nome} (-${quantity} keys)`);
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdCheckStock(interaction) {
    const productId = interaction.options.getString('product_id');
    
    if (productId) {
        // Verificar estoque de um produto específico
        const products = await Products.load();
        const product = products[productId];
        
        if (!product) {
            await Utils.safeReply(interaction, { content: `❌ Produto \`${productId}\` não encontrado.`, ephemeral: true });
            return;
        }
        
        const stock = await StockSystem.getStock(productId);
        
        await interaction.reply({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStockInfo(productId, product, { [productId]: stock })]
        });
        
    } else {
        // Verificar estoque geral
        const stockSummary = await StockSystem.getStockSummary();
        
        if (Object.keys(stockSummary).length === 0) {
            await Utils.safeReply(interaction, { content: '📭 Nenhum produto com estoque encontrado.', ephemeral: true });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setTitle('📦 Resumo de Estoque')
            .setDescription('Estoque disponível por produto e plano')
            .setColor('#0099ff');
        
        for (const [productId, data] of Object.entries(stockSummary).slice(0, 10)) {
            let stockText = '';
            let totalStock = 0;
            
            for (const [subIndex, subData] of Object.entries(data.subproducts)) {
                stockText += `• ${subData.name}: ${subData.available} keys\n`;
                totalStock += subData.available;
            }
            
            embed.addFields({
                name: `${data.title} (${totalStock} total)`,
                value: stockText || 'Sem estoque',
                inline: true
            });
        }
        
        await Utils.safeReply(interaction, { embeds: [embed] });
    }
}

async function cmdClearStock(interaction) {
    const productId = interaction.options.getString('product_id');
    const subproductIndex = interaction.options.getInteger('subproduct_index');
    
    const products = await Products.load();
    
    if (!products[productId]) {
        await Utils.safeReply(interaction, { content: `❌ Produto \`${productId}\` não encontrado.`, ephemeral: true });
        return;
    }
    
    const product = products[productId];
    
    if (subproductIndex !== null) {
        if (!product.subprodutos || !product.subprodutos[subproductIndex]) {
            await Utils.safeReply(interaction, { content: `❌ Plano com índice \`${subproductIndex}\` não encontrado.`, ephemeral: true });
            return;
        }
    }
    
    try {
        const clearedCount = await StockSystem.clearStock(productId, subproductIndex);
        
        const embed = new EmbedBuilder()
            .setTitle('🗑️ Estoque Limpo')
            .addFields(
                { name: 'Produto', value: product.titulo },
                { name: 'Escopo', value: subproductIndex !== null ? product.subprodutos[subproductIndex].nome : 'Todo o produto' },
                { name: 'Keys Removidas', value: clearedCount.toString() }
            )
            .setColor('#ff0000');
        
        await Utils.safeReply(interaction, { embeds: [embed] });
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdAddReseller(interaction) {
    const user = interaction.options.getUser('user');
    
    if (await Resellers.isReseller(user.id)) {
        await Utils.safeReply(interaction, { content: `❌ ${user.username} já é reseller.`, ephemeral: true });
        return;
    }
    
    await Resellers.add(user.id);
    
    const embed = new EmbedBuilder()
        .setTitle('✅ Reseller Adicionado')
        .addFields(
            { name: 'Usuário', value: user.username },
            { name: 'Desconto', value: `${CONFIG.RESELLER_DISCOUNT * 100}%` }
        )
        .setColor('#00ff00');
    
    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function cmdRemoveReseller(interaction) {
    const user = interaction.options.getUser('user');
    
    if (!(await Resellers.isReseller(user.id))) {
        await Utils.safeReply(interaction, { content: `❌ ${user.username} não é reseller.`, ephemeral: true });
        return;
    }
    
    await Resellers.remove(user.id);
    
    const embed = new EmbedBuilder()
        .setTitle('✅ Reseller Removido')
        .addFields({ name: 'Usuário', value: user.username })
        .setColor('#ff9900');
    
    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function cmdSetGlobalDiscount(interaction) {
    const percentage = interaction.options.getInteger('percentage');
    
    try {
        await GlobalDiscount.set(percentage, interaction.user.id);
        
        const embed = new EmbedBuilder()
            .setTitle('🌟 Desconto Global')
            .addFields(
                { name: 'Desconto', value: `${percentage}%` },
                { name: 'Status', value: percentage > 0 ? 'Ativado' : 'Desativado' },
                { name: 'Observação', value: 'Resellers não recebem desconto global (apenas desconto de reseller)' }
            )
            .setColor(percentage > 0 ? '#00ff00' : '#ff9900');
        
        await Utils.safeReply(interaction, { embeds: [embed] });
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdRemoveGlobalDiscount(interaction) {
    const currentDiscount = await GlobalDiscount.getInfo();
    
    if (!currentDiscount.active) {
        await Utils.safeReply(interaction, { content: '❌ Não há desconto ativo.', ephemeral: true });
        return;
    }
    
    await GlobalDiscount.remove(interaction.user.id);
    
    const embed = new EmbedBuilder()
        .setTitle('🌟 Desconto Removido')
        .addFields({ name: 'Anterior', value: `${(currentDiscount.percentage * 100).toFixed(0)}%` })
        .setColor('#ff9900');
    
    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function cmdConfirmPayment(interaction) {
    const user = interaction.options.getUser('user');
    const product = interaction.options.getString('product');
    const plan = interaction.options.getString('plan');
    const price = interaction.options.getString('price');
    const method = interaction.options.getString('method');
    const txId = interaction.options.getString('tx_id') || 'MANUAL_' + Date.now();
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Processando...', ephemeral: true });
        
        const deliveryResult = await DeliverySystem.deliverKey(user, product, plan, price, method, interaction.guild);
        const keyDelivered = deliveryResult.success;
        const basePrice = parseFloat(price.replace(/[^0-9.]/g, ''));
        const pricingInfo = await PricingSystem.calculateFinalPrice(basePrice, user.id);
        
        await TransactionSystem.save({
            userId: user.id, userTag: user.tag, product, plan, price, paymentMethod: method,
            status: 'completed', txid: txId, keyDelivered, confirmedBy: interaction.user.id, confirmationType: 'manual'
        });

        // Registrar no analytics
        await AnalyticsSystem.recordSale({
            userId: user.id, userTag: user.tag, product, plan, price, paymentMethod: method
        });
        
        await Logger.paymentConfirmed({
            userId: user.id, userTag: user.tag, product, plan, price, paymentMethod: method,
            txid: txId, keyDelivered, discounts: pricingInfo.discounts,
            confirmedBy: interaction.user.tag, confirmationType: 'manual',
            deliveredKey: deliveryResult.key
        });
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Pagamento Confirmado')
            .addFields(
                { name: 'Cliente', value: user.username },
                { name: 'Produto', value: `${product} - ${plan}` },
                { name: 'Valor', value: price },
                { name: 'Entrega', value: keyDelivered ? '✅ Automática' : '⚙️ Manual' }
            )
            .setColor('#00ff00');
        
        await interaction.editReply({ content: '', embeds: [embed] });
        
    } catch (error) {
        console.error('❌ Erro confirmando pagamento:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdAddSaldo(interaction) {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    
    try {
        const newBalance = await BalanceSystem.addBalance(user.id, amount, interaction.user.id);
        
        await interaction.reply({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildBalanceAdded(user.tag, amount, newBalance, interaction.user.tag)]
        });
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdRemoveSaldo(interaction) {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    
    try {
        const newBalance = await BalanceSystem.removeBalance(user.id, amount, interaction.user.id);
        
        const components = [
            {
                type: 12,
                items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
            },
            { type: 10, content: '# 💸 Saldo Removido!' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Saldo debitado com sucesso!** O valor foi removido da conta do usuário conforme solicitado.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `**👤 Usuário:** ${user.tag}\n**➖ Valor Removido:** R$ ${amount.toFixed(2)}\n**💰 Novo Saldo:** R$ ${newBalance.toFixed(2)}\n**👨‍💼 Removido por:** ${interaction.user.tag}` }
        ];
        
        await interaction.reply({
            flags: ['IsComponentsV2'],
            components: [{ type: 17, components }]
        });
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdSetSaldo(interaction) {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getNumber('amount');
    
    try {
        const newBalance = await BalanceSystem.setBalance(user.id, amount);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Saldo Definido')
            .addFields(
                { name: 'Usuário', value: user.tag },
                { name: 'Novo Saldo', value: `R$ ${newBalance.toFixed(2)}` }
            )
            .setColor('#00ff00');
        
        await Utils.safeReply(interaction, { embeds: [embed] });
        
    } catch (error) {
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function cmdCheckSaldo(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const balance = await BalanceSystem.getBalance(user.id);
    
    await interaction.reply({
        flags: ['IsComponentsV2'],
        components: [ComponentBuilder.buildBalanceInfo(user.tag, balance)]
    });
}

async function cmdTopSaldo(interaction) {
    const topBalances = await BalanceSystem.getTopBalances(10);
    
    if (topBalances.length === 0) {
        await Utils.safeReply(interaction, { content: '📭 Nenhum saldo encontrado.', ephemeral: true });
        return;
    }
    
    const embed = new EmbedBuilder()
        .setTitle('🏆 Top Saldos')
        .setColor('#ffd700');
    
    for (let i = 0; i < topBalances.length; i++) {
        const { userId, balance } = topBalances[i];
        try {
            const user = await client.users.fetch(userId);
            embed.addFields({
                name: `${i + 1}º ${user.username}`,
                value: `R$ ${balance.toFixed(2)}`,
                inline: true
            });
        } catch {
            embed.addFields({
                name: `${i + 1}º Usuário Desconhecido`,
                value: `R$ ${balance.toFixed(2)}`,
                inline: true
            });
        }
    }
    
    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function cmdGerarPagamento(interaction) {
    const valor = interaction.options.getNumber('valor');
    const user = interaction.options.getUser('user');
    const description = interaction.options.getString('description') || 'Pagamento personalizado';
    
    if (!efi || !process.env.PIX_KEY) {
        await Utils.safeReply(interaction, { content: '❌ Sistema PIX não configurado.', ephemeral: true });
        return;
    }
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Gerando pagamento PIX...', ephemeral: true });
        
        const payment = await CustomPaymentSystem.create(user.id, user.tag, valor, description, interaction.channel.id);
        
        const pixData = await PIX.createCharge(valor, description);
        
        const payments = await CustomPaymentSystem.load();
        const paymentIndex = payments.findIndex(p => p.id === payment.id);
        if (paymentIndex !== -1) {
            payments[paymentIndex].efiTxid = pixData.txid;
            payments[paymentIndex].pixCode = pixData.pixCopiaECola;
            await CustomPaymentSystem.save(payments);
            
            payment.efiTxid = pixData.txid;
            payment.pixCode = pixData.pixCopiaECola;
        }
        
        const qrFileName = `custom_pix_${payment.id}_${Date.now()}.png`;
        const qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
        const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
        
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildCustomPixPayment(valor, payment.id, description, qrFileName, payment.expiresAt, pixData.pixCopiaECola, `<@${user.id}>`)],
            files: [qrAttachment]
        });

        console.log(`🔄 Iniciando monitoramento para: ${payment.id} (EFI: ${payment.efiTxid})`);
        PIX.monitorCustomPayment(payment, interaction.channel.id);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Pagamento PIX Gerado')
            .addFields(
                { name: '👤 Cliente', value: user.tag },
                { name: '💵 Valor', value: `R$ ${valor.toFixed(2)}` },
                { name: '📋 Descrição', value: description },
                { name: '🆔 ID Interno', value: `\`${payment.id}\`` },
                { name: '🆔 ID EFI', value: `\`${pixData.txid}\`` },
                { name: '⏰ Expira', value: `<t:${Math.floor(payment.expiresAt / 1000)}:R>` }
            )
            .setColor('#00ff00');
        
        await interaction.editReply({ content: '', embeds: [embed] });
        
    } catch (error) {
        console.error('❌ Erro criando pagamento personalizado:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdConfirmPix(interaction) {
    const transactionId = interaction.options.getString('transaction_id');
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Confirmando pagamento...', ephemeral: true });
        
        const payments = await CustomPaymentSystem.load();
        let targetPayment = payments.find(p => p.id === transactionId || p.efiTxid === transactionId);
        
        if (!targetPayment) {
            await interaction.editReply({ content: `❌ Pagamento não encontrado: \`${transactionId}\`` });
            return;
        }
        
        const payment = await CustomPaymentSystem.confirm(targetPayment.id, interaction.user.tag, 'manual');
        
        await Logger.customPaymentConfirmed({
            userId: payment.userId,
            userTag: payment.userTag,
            valor: payment.valor,
            description: payment.description,
            txid: payment.id,
            efiTxid: payment.efiTxid,
            confirmedBy: interaction.user.tag,
            confirmationType: 'manual'
        });
        
        if (customPixPayments.has(payment.id)) {
            const pixData = customPixPayments.get(payment.id);
            clearInterval(pixData.interval);
            customPixPayments.delete(payment.id);
        }
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Pagamento PIX Confirmado')
            .addFields(
                { name: '👤 Cliente', value: payment.userTag },
                { name: '💰 Valor', value: `R$ ${payment.valor.toFixed(2)}` },
                { name: '📋 Descrição', value: payment.description },
                { name: '🆔 ID Interno', value: payment.id },
                { name: '🆔 ID EFI', value: payment.efiTxid || 'N/A' },
                { name: '👨‍💼 Confirmado por', value: interaction.user.tag }
            )
            .setColor('#00ff00');
        
        await interaction.editReply({ content: '', embeds: [embed] });
        
        if (payment.channelId) {
            try {
                const channel = client.channels.cache.get(payment.channelId);
                if (channel && !channel.deleted) {
                    const components = [
                        {
                            type: 12,
                            items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                        },
                        { type: 10, content: '# ✅ PIX Confirmado!' },
                        { type: 14, divider: true, spacing: 1 },
                        { type: 10, content: '> **Pagamento processado com sucesso!** O valor foi confirmado e creditado na conta.' },
                        { type: 14, divider: false, spacing: 1 },
                        { type: 10, content: `**👤 Cliente:** ${payment.userTag}\n**💰 Valor:** R$ ${payment.valor.toFixed(2)}\n**📋 Descrição:** ${payment.description}\n**🆔 Transação:** ${payment.id}\n**✅ Status:** Confirmado manualmente por ${interaction.user.tag}` },
                        { type: 14, divider: true, spacing: 1 },
                        { type: 10, content: '🎉 **Obrigado!** Seu pagamento foi processado com sucesso.' }
                    ];
                    
                    await channel.send({
                        flags: ['IsComponentsV2'],
                        components: [{ type: 17, components }]
                    });
                }
            } catch (channelError) {
                console.error('Erro notificando canal:', channelError);
            }
        }
        
    } catch (error) {
        console.error('❌ Erro confirmando PIX:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function cmdListPayments(interaction) {
    const activePayments = await CustomPaymentSystem.getActivePayments();
    
    if (activePayments.length === 0) {
        await Utils.safeReply(interaction, { content: '📭 Nenhum pagamento ativo no momento.', ephemeral: true });
        return;
    }
    
    const embed = new EmbedBuilder()
        .setTitle('📋 Pagamentos Ativos')
        .setDescription(`Total: ${activePayments.length}`)
        .setColor('#0099ff');
    
    for (const payment of activePayments.slice(0, 10)) {
        const timeLeft = Math.max(0, payment.expiresAt - Date.now());
        const minutesLeft = Math.floor(timeLeft / 60000);
        
        embed.addFields({
            name: `💰 R$ ${payment.valor.toFixed(2)} - ${payment.userTag}`,
            value: `**ID Interno:** \`${payment.id}\`\n**ID EFI:** \`${payment.efiTxid || 'N/A'}\`\n**Descrição:** ${payment.description}\n**Expira em:** ${minutesLeft}min`,
            inline: true
        });
    }
    
    await Utils.safeReply(interaction, { embeds: [embed] });
}

// ===== SELECT MENU HANDLERS =====
async function handleSelectMenu(interaction) {
    if (interaction.customId === 'payment_method') {
        await handlePaymentSelect(interaction);
    } else if (interaction.customId === 'cart_payment_select') {
        await handleCartPaymentSelect(interaction);
    } else if (interaction.customId.startsWith('cart_product_select_')) {
        await handleCartProductSelect(interaction);
    } else if (interaction.customId === 'add_to_cart_select') {
        await handleAddToCartSelect(interaction);
    } else if (interaction.customId === 'remove_item_select') {
        await handleRemoveItemSelect(interaction);
    } else if (interaction.customId.startsWith('product_select_')) {
        await handleProductSelect(interaction);
    } else if (interaction.customId.startsWith('subproduct_select_')) {
        await handleSubproductSelect(interaction);
    } else if (interaction.customId.startsWith('cart_actions_')) {
        await handleCartActions(interaction);
    } else if (interaction.customId === 'stock_product_select') {
        await handleStockProductSelect(interaction);
    } else if (interaction.customId === 'stock_subproduct_select') {
        await handleStockSubproductSelect(interaction);
    } else if (interaction.customId === 'stock_action_select') {
        await handleStockActionSelect(interaction);
    } else if (interaction.customId === 'remove_stock_product_select') {
        await handleRemoveStockProductSelect(interaction);
    } else if (interaction.customId === 'remove_stock_subproduct_select') {
        await handleRemoveStockSubproductSelect(interaction);
    } else if (interaction.customId === 'stats_category') {
        await handleStatsCategory(interaction);
    } else if (interaction.customId.startsWith('embed_subproduct_select_')) {
        await handleEmbedSubproductSelect(interaction);
    } else if (interaction.customId === 'edit_product_select') {
        await handleEditProductSelect(interaction);
    } else if (interaction.customId === 'set_embed_select') {
        await handleSetEmbedSelect(interaction);
    }
}

async function handleStatsCategory(interaction) {
    const category = interaction.values[0];
    
    try {
        await Utils.safeReply(interaction, { content: '📊 Carregando dados...', ephemeral: true });
        
        switch (category) {
            case 'top_products':
                const topProducts = await AnalyticsSystem.getTopProducts(10);
                await interaction.editReply({
                    content: '',
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildTopProducts(topProducts)]
                });
                break;
                
            case 'top_customers':
                const topCustomers = await AnalyticsSystem.getTopCustomers(10);
                await interaction.editReply({
                    content: '',
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildTopCustomers(topCustomers)]
                });
                break;
                
            case 'daily_sales':
                const dailyStats = await AnalyticsSystem.getDailyStats(30);
                await interaction.editReply({
                    content: '',
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildDailySales(dailyStats)]
                });
                break;
                
            case 'payment_methods':
                const paymentStats = await AnalyticsSystem.getPaymentMethodStats();
                await interaction.editReply({
                    content: '',
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildPaymentMethodStats(paymentStats)]
                });
                break;
                
            case 'monthly_revenue':
                const monthlyStats = await AnalyticsSystem.getMonthlyRevenue();
                await interaction.editReply({
                    content: '',
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildMonthlyRevenue(monthlyStats)]
                });
                break;
                
            default:
                await interaction.editReply({ content: '❌ Categoria não reconhecida.' });
        }
        
    } catch (error) {
        console.error('❌ Erro carregando categoria de stats:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}



async function handleEmbedSubproductSelect(interaction) {
    try {
        console.log('🎯 handleEmbedSubproductSelect chamado');
        console.log('📥 interaction.values[0]:', interaction.values[0]);
        console.log('🔧 interaction.customId:', interaction.customId);
        
        const parts = interaction.values[0].split('_');
        const productId = `${parts[0]}_${parts[1]}`;
        const subproductIndex = parts[2];
        console.log('🔍 ProductId extraído:', productId);
        console.log('🔍 SubproductIndex extraído:', subproductIndex);
        
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const product = products[productId];
        
        console.log('🎯 Produto encontrado:', product ? product.titulo : 'NÃO ENCONTRADO');
        console.log('📋 Subprodutos disponíveis:', product ? product.subprodutos.length : 0);
        
        if (!product || !product.subprodutos[subproductIndex]) {
            await Utils.safeReply(interaction, { content: `❌ Produto ou plano não encontrado. ProductId: ${productId}, Index: ${subproductIndex}`, ephemeral: true });
            return;
        }
        
        const subproduct = product.subprodutos[subproductIndex];
        
        // Verificar estoque
        const stock = await Utils.loadJSON(CONFIG.STOCK_FILE, {});
        const productStock = stock[productId] || [];
        const availableStock = productStock[subproductIndex] || [];
        
        if (availableStock.length === 0) {
            await Utils.safeReply(interaction, { 
                content: `❌ Produto **${product.titulo}** - Plano **${subproduct.nome}** está temporariamente esgotado.`, 
                ephemeral: true 
            });
            return;
        }
        
        // Responder imediatamente para evitar timeout
        await interaction.deferUpdate();
        
        // Criar canal de compra em segundo plano
        try {
            const channel = await CartSystem.createChannel(interaction.guild, interaction.user, product, subproduct, 'pix');
            
            // Enviar mensagem ephemeral para o cliente em Components V2
            await interaction.followUp({
                flags: ['IsComponentsV2'],
                components: [{
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: '✅ **Canal de Compra Criado!**'
                        },
                        {
                            type: 10,
                            content: `**Produto:** ${product.titulo}\n**Plano:** ${subproduct.nome}\n**Preço:** R$ ${subproduct.preco}`
                        },
                        {
                            type: 14,
                            divider: true,
                            spacing: 1
                        },
                        {
                            type: 10,
                            content: '📋 **Próximos Passos**\nAcesse o canal criado para finalizar sua compra.'
                        },
                        {
                            type: 1,
                            components: [
                                {
                                    type: 2,
                                    style: 5,
                                    label: '🛒 Acessar Carrinho',
                                    url: `https://discord.com/channels/${interaction.guild.id}/${channel.id}`
                                }
                            ]
                        }
                    ]
                }],
                ephemeral: true
            });
            
        } catch (error) {
            console.error('❌ Erro criando carrinho:', error);
            // Em caso de erro, enviar mensagem ephemeral de erro em Components V2
            await interaction.followUp({
                flags: ['IsComponentsV2'],
                components: [{
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: '❌ **Erro ao Criar Carrinho**'
                        },
                        {
                            type: 10,
                            content: 'Houve um problema ao processar sua solicitação. Tente novamente ou entre em contato com o suporte.'
                        },
                        {
                            type: 14,
                            divider: true,
                            spacing: 1
                        },
                        {
                            type: 10,
                            content: '🔧 **Soluções:**\n• Verifique sua conexão\n• Tente novamente em alguns segundos\n• Entre em contato com o suporte'
                        }
                    ]
                }],
                ephemeral: true
            });
        }
        
    } catch (error) {
        console.error('❌ Erro ao selecionar subproduto:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleModal(interaction) {
    if (interaction.customId === 'create_product') {
        await handleCreateProductModal(interaction);
    } else if (interaction.customId.startsWith('payment_method_modal_')) {
        await handlePaymentMethodModal(interaction);
    } else if (interaction.customId.startsWith('add_stock_modal--')) {
        await handleAddStockModal(interaction);
    } else if (interaction.customId.startsWith('remove_stock_modal_')) {
        await handleRemoveStockModal(interaction);
    } else if (interaction.customId.startsWith('edit_product_')) {
        await handleEditProductModal(interaction);
    } else if (interaction.customId === 'updates_modal') {
        await handleUpdatesModal(interaction);
    }
}

async function handleButton(interaction) {
    // Handler para o botão "Compre Aqui"
    if (interaction.customId === '1defe44681204b489b026465428b8785') {
        await handleShoppingCartOpen(interaction);
    // Removido handler back_to_store - botão deletado conforme solicitado
    // } else if (interaction.customId === 'back_to_store') {
    //     await handleBackToStore(interaction);
    } else if (interaction.customId === 'add_more_products') {
        await handleAddMoreProducts(interaction);
    } else if (interaction.customId === 'finalize_purchase') {
        await handleFinalizePurchase(interaction);
    } else if (interaction.customId === 'back_to_product_list') {
        await handleBackToProductList(interaction);
    } else if (interaction.customId === 'back_to_cart') {
        await handleBackToCart(interaction);
    } else if (interaction.customId === 'confirm_payment') {
        await handleConfirmPayment(interaction);
    } else if (interaction.customId.startsWith('complete_single_purchase_')) {
        await handleCompleteSinglePurchase(interaction);
    } else if (interaction.customId.startsWith('back_to_products_')) {
        await handleBackToProducts(interaction);
    } else if (interaction.customId === 'back_to_stock_products') {
        await handleBackToStockProducts(interaction);
    } else if (interaction.customId === 'back_to_stock_menu') {
        await handleBackToStockMenu(interaction);
    } else if (interaction.customId === 'back_to_remove_stock_products') {
        await handleBackToRemoveStockProducts(interaction);
    } else if (interaction.customId === 'refresh_stock_monitor') {
        await handleRefreshStockMonitor(interaction);
    } else if (interaction.customId.startsWith('add_stock_to_')) {
        await handleAddStockButton(interaction);
    } else if (interaction.customId.startsWith('emergency_add_stock_')) {
        await handleEmergencyAddStock(interaction);
    } else if (interaction.customId.startsWith('quick_add_stock_')) {
        await handleQuickAddStock(interaction);
    } else if (interaction.customId === 'view_all_stock') {
        await handleViewAllStock(interaction);
    } else if (interaction.customId.startsWith('emergency_restock_')) {
        await handleEmergencyRestock(interaction);
            } else if (interaction.customId === 'back_to_dashboard') {
            await handleBackToDashboard(interaction);
        } else if (interaction.customId === 'f792b207a70547b8dfa1b3737d822826') {
            await handleValorButton(interaction);
        } else if (interaction.customId === 'a6c402fd41dc47e4a4b216b70162a776') {
            await handleDataButton(interaction);
        } else if (interaction.customId.startsWith('start_purchase_')) {
        await handleStartPurchase(interaction);
    } else if (interaction.customId === 'ticket_create') {
        await handleTicketCreate(interaction);
    } else if (interaction.customId === 'ticket_close') {
        await handleTicketClose(interaction);
    } else if (interaction.customId === 'ticket_close_confirm') {
        await handleTicketCloseConfirm(interaction);
    }
}

async function handleBackToDashboard(interaction) {
    try {
        const summary = await AnalyticsSystem.getSummary();
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStatsDashboard(summary)]
        });
        
    } catch (error) {
        console.error('❌ Erro voltando ao dashboard:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleTicketCreate(interaction) {
    try {
        const guild = interaction.guild;
        const user = interaction.user;
        
        // Verificar se o usuário já tem um ticket ativo
        const existingTicket = guild.channels.cache.find(ch => 
            ch.name.includes('ticket-') && 
            ch.name.includes(user.username.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
        
        if (existingTicket) {
            await Utils.safeReply(interaction, { 
                content: `⚠️ Você já possui um ticket ativo!\n📋 Canal: <#${existingTicket.id}>`,
                ephemeral: true 
            });
            return;
        }
        
        // Criar canal do ticket
        const ticketChannel = await guild.channels.create({
            name: `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
            type: ChannelType.GuildText,
            parent: CONFIG.TICKET_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                },
                {
                    id: user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory
                    ]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.ManageChannels
                    ]
                }
            ]
        });
        
        // Criar embed de boas-vindas do ticket
        const welcomeEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 4,
                        label: "🔒 Fechar Ticket",
                        emoji: null,
                        disabled: false,
                        custom_id: "ticket_close"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🎫 Atendimento"
                        }
                    ]
                },
                {
                    type: 10,
                    content: "Seja bem-vindo(a) ao nosso sistema de suporte.\nPor meio deste canal, você terá contato direto com nossa equipe, garantindo um atendimento ágil, claro e eficiente."
                }
            ]
        };
        
        await ticketChannel.send({
            flags: ['IsComponentsV2'],
            components: [welcomeEmbed]
        });
        
        // Enviar confirmação ephemeral para o usuário
        await Utils.safeReply(interaction, { 
            content: `✅ Ticket criado com sucesso!\n📋 Canal: <#${ticketChannel.id}>`,
            ephemeral: true 
        });
        
        console.log(`🎫 Ticket criado: ${user.tag} - Canal: ${ticketChannel.name}`);
        
    } catch (error) {
        console.error('❌ Erro criando ticket:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro ao criar ticket: ${error.message}`, ephemeral: true });
    }
}

async function handleTicketClose(interaction) {
    try {
        const channel = interaction.channel;
        const user = interaction.user;
        
        // Verificar se é um canal de ticket
        if (!channel.name.startsWith('ticket-')) {
            await Utils.safeReply(interaction, { content: '❌ Este não é um canal de ticket válido.', ephemeral: true });
            return;
        }
        
        // Criar embed de confirmação
        const confirmEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 4,
                        label: "✅ Confirmar Fechamento",
                        emoji: null,
                        disabled: false,
                        custom_id: "ticket_close_confirm"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🔒 Fechar Ticket"
                        }
                    ]
                },
                {
                    type: 10,
                    content: `**Tem certeza que deseja fechar este ticket?**\n\n👤 **Usuário:** ${user.tag}\n📋 **Canal:** ${channel.name}\n\n⚠️ **Atenção:** Esta ação não pode ser desfeita. O canal será deletado permanentemente.`
                }
            ]
        };
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [confirmEmbed]
        });
        
    } catch (error) {
        console.error('❌ Erro ao tentar fechar ticket:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleTicketCloseConfirm(interaction) {
    try {
        const channel = interaction.channel;
        const user = interaction.user;
        
        // Verificar se é um canal de ticket
        if (!channel.name.startsWith('ticket-')) {
            await Utils.safeReply(interaction, { content: '❌ Este não é um canal de ticket válido.', ephemeral: true });
            return;
        }
        
        // Deletar o canal
        await channel.delete();
        
        console.log(`🔒 Ticket fechado: ${user.tag} - Canal: ${channel.name}`);
        
    } catch (error) {
        console.error('❌ Erro ao fechar ticket:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro ao fechar ticket: ${error.message}`, ephemeral: true });
    }
}



async function handleStartPurchase(interaction) {
    try {
        const [productId, subproductIndex] = interaction.customId.replace('start_purchase_', '').split('_');
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const product = products[productId];
        
        if (!product || !product.subprodutos[subproductIndex]) {
            await Utils.safeReply(interaction, { content: '❌ Produto ou plano não encontrado.', ephemeral: true });
            return;
        }
        
        const subproduct = product.subprodutos[subproductIndex];
        
        // Verificar estoque novamente
        const stock = await Utils.loadJSON(CONFIG.STOCK_FILE, {});
        const productStock = stock[productId] || [];
        const availableStock = productStock[subproductIndex] || [];
        
        if (availableStock.length === 0) {
            await Utils.safeReply(interaction, { 
                content: `❌ Produto **${product.titulo}** - Plano **${subproduct.nome}** está temporariamente esgotado.`, 
                ephemeral: true 
            });
            return;
        }
        
        // Criar canal de compra
        const channel = await CartSystem.createChannel(interaction.guild, interaction.user, product, subproduct, 'pix');
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Canal de Compra Criado!')
            .setDescription(`**Produto:** ${product.titulo}\n**Plano:** ${subproduct.nome}\n**Preço:** R$ ${subproduct.preco}`)
            .setColor('#00ff00')
            .addFields(
                { name: '📋 Próximos Passos', value: 'Acesse o canal criado para finalizar sua compra.', inline: false }
            )
            .setTimestamp();
        
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setURL(`https://discord.com/channels/${interaction.guild.id}/${channel.id}`)
                    .setLabel('🛒 Ir para Compra')
                    .setStyle(ButtonStyle.Link)
            );
        
        await interaction.update({
            embeds: [embed],
            components: [row]
        });
        
    } catch (error) {
        console.error('❌ Erro iniciando compra:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleEditProductModal(interaction) {
    try {
        const productId = interaction.customId.replace('edit_product_', '');
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const product = products[productId];
        
        if (!product) {
            await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
            return;
        }
        
        // Obter valores do modal
        const titulo = interaction.fields.getTextInputValue('titulo').trim();
        const descricao = interaction.fields.getTextInputValue('descricao').trim();
        const informacoes = interaction.fields.getTextInputValue('informacoes').trim();
        const imagem = interaction.fields.getTextInputValue('imagem').trim();
        const siteUrl = interaction.fields.getTextInputValue('site_url').trim();
        const siteLabel = 'Nosso Site!'; // Valor padrão
        
        // Validar campos obrigatórios
        if (!titulo || !descricao) {
            await Utils.safeReply(interaction, { content: '❌ Título e descrição são obrigatórios.', ephemeral: true });
            return;
        }
        
        // Atualizar produto
        product.titulo = titulo;
        product.descricao = descricao;
        product.informacoes = informacoes || undefined;
        product.imagem = imagem || undefined;
        product.site_url = siteUrl || undefined;
        product.site_label = siteLabel || undefined;
        
        // Remover campos vazios
        if (!product.informacoes) delete product.informacoes;
        if (!product.imagem) delete product.imagem;
        if (!product.site_url) delete product.site_url;
        if (!product.site_label) delete product.site_label;
        
        // Salvar alterações
        products[productId] = product;
        await Utils.saveJSON(CONFIG.PRODUCTS_FILE, products);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Produto Atualizado')
            .setDescription(`**${titulo}** foi atualizado com sucesso!`)
            .addFields(
                { name: '📝 Título', value: titulo, inline: true },
                { name: '📋 Descrição', value: descricao.length > 50 ? descricao.substring(0, 50) + '...' : descricao, inline: true },
                { name: '🖼️ Imagem', value: imagem ? '✅ Configurada' : '❌ Não configurada', inline: true },
                { name: '🌐 Site', value: siteUrl ? '✅ Configurado' : '❌ Não configurado', inline: true },
                { name: '🏷️ Botão', value: siteLabel || 'Padrão', inline: true }
            )
            .setColor('#00ff00')
            .setTimestamp();
        
        await Utils.safeReply(interaction, { embeds: [embed] });
        
    } catch (error) {
        console.error('❌ Erro ao editar produto:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleEditProductSelect(interaction) {
    try {
        const productId = interaction.values[0];
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        const product = products[productId];
        
        if (!product) {
            await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
            return;
        }
        
        // Criar modal para edição
        const modal = new ModalBuilder()
            .setCustomId(`edit_product_${productId}`)
            .setTitle(`Editar Produto: ${product.titulo}`);
        
        const tituloInput = new TextInputBuilder()
            .setCustomId('titulo')
            .setLabel('Título do Produto')
            .setStyle(TextInputStyle.Short)
            .setValue(product.titulo)
            .setRequired(true);
        
        const descricaoInput = new TextInputBuilder()
            .setCustomId('descricao')
            .setLabel('Descrição do Produto')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(product.descricao)
            .setRequired(true);
        
        const informacoesInput = new TextInputBuilder()
            .setCustomId('informacoes')
            .setLabel('Informações (opcional)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(product.informacoes || '')
            .setRequired(false);
        
        const imagemInput = new TextInputBuilder()
            .setCustomId('imagem')
            .setLabel('URL da Imagem (opcional)')
            .setStyle(TextInputStyle.Short)
            .setValue(product.imagem || '')
            .setRequired(false);
        
        const siteUrlInput = new TextInputBuilder()
            .setCustomId('site_url')
            .setLabel('URL do Site (opcional)')
            .setStyle(TextInputStyle.Short)
            .setValue(product.site_url || '')
            .setRequired(false);
        
        const siteLabelInput = new TextInputBuilder()
            .setCustomId('site_label')
            .setLabel('Texto do Botão do Site (opcional)')
            .setStyle(TextInputStyle.Short)
            .setValue(product.site_label || 'Nosso Site!')
            .setRequired(false);
        
        const firstActionRow = new ActionRowBuilder().addComponents(tituloInput);
        const secondActionRow = new ActionRowBuilder().addComponents(descricaoInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(informacoesInput);
        const fourthActionRow = new ActionRowBuilder().addComponents(imagemInput);
        const fifthActionRow = new ActionRowBuilder().addComponents(siteUrlInput);
        
        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow, fourthActionRow, fifthActionRow);
        
        await interaction.showModal(modal);
        
    } catch (error) {
        console.error('❌ Erro ao selecionar produto para edição:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleSetEmbedSelect(interaction) {
    try {
        const productId = interaction.values[0];
        console.log('🔍 ProductId recebido:', productId);
        
        const products = await Utils.loadJSON(CONFIG.PRODUCTS_FILE, {});
        console.log('📦 Produtos carregados:', Object.keys(products));
        
        const product = products[productId];
        console.log('🎯 Produto encontrado:', product ? product.titulo : 'NÃO ENCONTRADO');
        
        if (!product) {
            await Utils.safeReply(interaction, { content: `❌ Produto não encontrado. ID: ${productId}`, ephemeral: true });
            return;
        }
        
        // Criar opções para os subprodutos
        const subproductOptions = product.subprodutos.map((subproduct, index) => ({
            label: `${subproduct.nome} - R$ ${subproduct.preco}`,
            value: `${productId}_${index}`,
            description: `Plano ${subproduct.nome} por R$ ${subproduct.preco}`
        }));
        
        // Adicionar ID do produto para referência
        product.id = productId;
        console.log('🆔 Product ID definido:', product.id);
        console.log('📋 SubproductOptions:', subproductOptions);
        
        // Enviar embed do produto específico
        const embed = ComponentBuilder.buildProductDetailEmbed(product, subproductOptions);
        console.log('🎨 Embed construído:', JSON.stringify(embed, null, 2));
        
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: embed
        });
        
        await interaction.reply({ content: `✅ Embed do produto **${product.titulo}** criada com sucesso!`, ephemeral: true });
        
    } catch (error) {
        console.error('❌ Erro ao criar embed do produto:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleCreateProductModal(interaction) {
    const title = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const subproductsStr = interaction.fields.getTextInputValue('subproducts').trim();
    
    const subproducts = [];
    for (const part of subproductsStr.split(',')) {
        const [nome, preco] = part.trim().split(':');
        
        if (!nome || !preco) {
            await Utils.safeReply(interaction, { content: '❌ Formato inválido! Use: nome:preço_BRL', ephemeral: true });
            return;
        }
        
        const precoNum = parseFloat(preco);
        if (isNaN(precoNum) || precoNum <= 0) {
            await Utils.safeReply(interaction, { content: `❌ Preço inválido para "${nome}"!`, ephemeral: true });
            return;
        }
        
        subproducts.push({ nome: nome.trim(), preco: precoNum });
    }

    const id = await Products.create(title, description, subproducts);

    const embed = new EmbedBuilder()
        .setTitle('✅ Produto Criado')
        .addFields(
            { name: 'Título', value: title },
            { name: 'ID', value: `\`${id}\`` },
            { name: 'Planos', value: subproducts.map(s => `${s.nome}: R$ ${s.preco.toFixed(2)}`).join('\n') }
        )
        .setColor('#00ff00')
        .setFooter({ text: 'Use /addstock para adicionar keys aos planos' });

    await Utils.safeReply(interaction, { embeds: [embed] });
}

async function handlePaymentMethodModal(interaction) {
    const parts = interaction.customId.split('_');
    const productId = parts[3];
    const subIndex = parseInt(parts[4]);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }
    
    const paymentMethod = interaction.fields.getTextInputValue('method_input').toLowerCase().trim();

    await Utils.safeReply(interaction, { content: '🔄 Criando carrinho...', ephemeral: true });

    try {
        const channel = await CartSystem.createChannel(interaction.guild, interaction.user, product, subproduct, paymentMethod);
        
        const components = [
            { type: 10, content: '# <:carrinhodepessoa:1380665582495469718> Carrinho Criado' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `<:porcento20:1380664304990425088> **${product.titulo}** - ${subproduct.nome}\n<:comentariosdolar:1380664648071774321> Forma de Pagamento:  ${Utils.getPaymentDisplay(paymentMethod)}` },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 5, label: 'Acessar Carrinho', url: `https://discord.com/channels/${interaction.guild.id}/${channel.id}` }
            ]}
        ];

        await interaction.editReply({ 
            content: null,
            embeds: [],
            components: [{ type: 17, components }],
            flags: ['IsComponentsV2']
        });

    } catch (error) {
        console.error('❌ Erro criando carrinho:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handlePaymentSelect(interaction) {
    const payment = interaction.values[0];
    const products = await Products.load();
    const stockAll = await StockSystem.getAllStock();
    
    if (Object.keys(products).length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Nenhum produto disponível no momento.', ephemeral: true });
        return;
    }

    const isUserReseller = await Resellers.isReseller(interaction.user.id);
    
    const options = Object.entries(products)
        .filter(([id, product]) => product.subprodutos?.length > 0)
        .filter(([id]) => {
            const pStock = stockAll[id] || {};
            return Object.values(pStock).some(arr => Array.isArray(arr) && arr.length > 0);
        })
        .slice(0, 25)
        .map(([id, product]) => ({
            label: product.titulo,
            value: id
        }));

    const catalogContainer = ComponentBuilder.buildProductCatalog(payment, options);
    
    if (isUserReseller) {
        catalogContainer.components.splice(1, 0, {
            type: 1,
            components: [{
                type: 2,
                style: 3,
                label: `🎖️ Você é Reseller - ${(CONFIG.RESELLER_DISCOUNT * 100)}% OFF em todos os produtos!`,
                custom_id: 'user_reseller_badge',
                disabled: true
            }]
        });
    }

    await Utils.safeReply(interaction, { 
        flags: ['IsComponentsV2'],
        components: [catalogContainer],
        ephemeral: true
    });
}

async function handleProductSelect(interaction) {
    const productId = interaction.values[0];
    const payment = interaction.customId.split('_')[2];
    const products = await Products.load();
    const product = products[productId];
    const stock = await StockSystem.getStock(productId);

    if (!product?.subprodutos) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }
    // Se nenhum plano tiver estoque, retorna aviso e interrompe
    if (!Object.values(stock).some(arr => Array.isArray(arr) && arr.length > 0)) {
        await Utils.safeReply(interaction, { content: '❌ Este produto está temporariamente esgotado.', ephemeral: true });
        return;
    }
    
    const options = [];
    
    for (let index = 0; index < Math.min(product.subprodutos.length, 25); index++) {
        const sub = product.subprodutos[index];
        const pricingInfo = await PricingSystem.calculateFinalPrice(parseFloat(sub.preco), interaction.user.id);
        const availableStock = stock[index] ? stock[index].length : 0;
        
        if (availableStock <= 0) {
            continue; // Oculta planos sem estoque
        }

        const priceText = pricingInfo.hasDiscounts ? 
            `R$ ${pricingInfo.finalPrice.toFixed(2)} ➔ era R$ ${pricingInfo.originalPrice.toFixed(2)}` : 
            `R$ ${pricingInfo.finalPrice.toFixed(2)}`;
        
        options.push({
            label: sub.nome,
            value: `${productId}|${index}`,
            description: `${priceText}`.slice(0, 100)
        });
    }

    if (options.length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Este produto está temporariamente esgotado.', ephemeral: true });
        return;
    }

    const productContainer = ComponentBuilder.buildProductDetails(product, payment, options);

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [productContainer]
    });
}

async function handleSubproductSelect(interaction) {
    const [productId, subIndex] = interaction.values[0].split('|');
    const payment = interaction.customId.split('_')[2];
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[parseInt(subIndex)];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }

    // Verificar se há estoque
    const stockAvailable = await StockSystem.getAvailableCount(productId, parseInt(subIndex));
    
    if (stockAvailable === 0) {
        await Utils.safeReply(interaction, { 
            content: '❌ Este produto está temporariamente esgotado. Nossa equipe foi notificada.', 
            ephemeral: true 
        });
        return;
    }

    if (payment === 'another_method') {
        const modal = new ModalBuilder()
            .setCustomId(`payment_method_modal_${productId}_${subIndex}`)
            .setTitle('Método de Pagamento');

        const methodInput = new TextInputBuilder()
            .setCustomId('method_input')
            .setLabel('Método Desejado')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: PayPal, Transferência...')
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(methodInput));
        await interaction.showModal(modal);
        return;
    }

    await Utils.safeReply(interaction, { content: '🔄 Criando carrinho...', ephemeral: true });

    try {
        const channel = await CartSystem.createChannel(interaction.guild, interaction.user, product, subproduct, payment);
        
        const components = [
            { type: 10, content: '# <:carrinhodepessoa:1380665582495469718> Carrinho Criado' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: `<:porcento20:1380664304990425088> **${product.titulo}** - ${subproduct.nome}\n<:comentariosdolar:1380664648071774321> Forma de Pagamento:  ${Utils.getPaymentDisplay(payment)}\n📦 **Estoque:** ${stockAvailable} unidades disponíveis` },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [
                { type: 2, style: 5, label: 'Acessar Carrinho', url: `https://discord.com/channels/${interaction.guild.id}/${channel.id}` }
            ]}
        ];

        await interaction.editReply({ 
            content: null,
            embeds: [],
            components: [{ type: 17, components }],
            flags: ['IsComponentsV2']
        });

    } catch (error) {
        console.error('❌ Erro criando carrinho:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handleCartActions(interaction) {
    const action = interaction.values[0];
    
    if (action.startsWith('finalize_balance_')) {
        await handleFinalizeBalance(interaction, action);
    } else if (action.startsWith('finalize_purchase_')) {
        await handleFinalizePurchase(interaction, action);
    } else if (action.startsWith('toggle_balance_')) {
        await handleToggleBalance(interaction, action);
    } else if (action.startsWith('cancel_order_')) {
        await handleCancelOrder(interaction, action);
    } else if (action.startsWith('out_of_stock_')) {
        await Utils.safeReply(interaction, { 
            content: '❌ Este produto está temporariamente esgotado. Nossa equipe foi notificada.', 
            ephemeral: true 
        });
    }
}

async function handleBackToProducts(interaction) {
    const paymentMethod = interaction.customId.split('_')[3];
    const products = await Products.load();
    const stockAll = await StockSystem.getAllStock();
    
    if (Object.keys(products).length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Nenhum produto disponível.', ephemeral: true });
        return;
    }

    const options = Object.entries(products)
        .filter(([id, product]) => product.subprodutos?.length > 0)
        .filter(([id]) => {
            const pStock = stockAll[id] || {};
            return Object.values(pStock).some(arr => Array.isArray(arr) && arr.length > 0);
        })
        .slice(0, 25)
        .map(([id, product]) => ({
            label: product.titulo,
            value: id
        }));

    const catalogContainer = ComponentBuilder.buildProductCatalog(paymentMethod, options);

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [catalogContainer]
    });
}

async function handleToggleBalance(interaction, action) {
    const parts = action.split('_');
    const channelId = parts[2];
    const toggleAction = parts[3];
    
    try {
        const cartData = global.cartDataMap?.get(channelId);
        if (!cartData) {
            await Utils.safeReply(interaction, { content: '❌ Dados do carrinho não encontrados.', ephemeral: true });
            return;
        }
        
        cartData.useBalance = (toggleAction === 'enable');
        
        global.cartDataMap.set(channelId, cartData);
        
        const userBalance = await BalanceSystem.getBalance(interaction.user.id);
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildCart(
                cartData.user, 
                cartData.product, 
                cartData.subproduct, 
                cartData.paymentMethod, 
                cartData.displayPrice, 
                cartData.stockAvailable,
                cartData.pricingInfo, 
                channelId, 
                cartData.useBalance, 
                userBalance
            )]
        });
        
    } catch (error) {
        console.error('❌ Erro alternando saldo:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro ao alternar uso do saldo.', ephemeral: true });
    }
}

async function handleFinalizeBalance(interaction, action) {
    const parts = action.split('_');
    const channelId = parts[2];
    
    try {
        const cartData = global.cartDataMap?.get(channelId);
        if (!cartData) {
            await Utils.safeReply(interaction, { content: '❌ Dados do carrinho não encontrados.', ephemeral: true });
            return;
        }
        
        // Verificar estoque novamente
        if (cartData.stockAvailable === 0) {
            await Utils.safeReply(interaction, { content: '❌ Produto esgotado.', ephemeral: true });
            return;
        }
        
        await Utils.safeReply(interaction, { content: '🔄 Processando pagamento com saldo...', ephemeral: true });
        
        const finalPrice = cartData.pricingInfo.finalPrice;
        const userBalance = await BalanceSystem.getBalance(interaction.user.id);
        
        if (userBalance < finalPrice) {
            await interaction.editReply({ 
                content: `❌ Saldo insuficiente. Necessário: R$ ${finalPrice.toFixed(2)}, Disponível: R$ ${userBalance.toFixed(2)}` 
            });
            return;
        }
        
        const remainingBalance = await BalanceSystem.consumeBalance(
            interaction.user.id, 
            finalPrice, 
            `${cartData.product.titulo} - ${cartData.subproduct.nome}`
        );
        
        const deliveryResult = await DeliverySystem.deliverKey(
            cartData.user, 
            cartData.product.titulo, 
            cartData.subproduct.nome, 
            `R$ ${finalPrice.toFixed(2)}`, 
            'balance', 
            interaction.guild
        );
        const keyDelivered = deliveryResult.success;
        
        await TransactionSystem.save({
            userId: cartData.user.id,
            userTag: cartData.user.tag,
            product: cartData.product.titulo,
            plan: cartData.subproduct.nome,
            price: `R$ ${finalPrice.toFixed(2)}`,
            paymentMethod: 'balance',
            status: 'completed',
            txid: Utils.generateTransactionId(),
            keyDelivered,
            balanceUsed: finalPrice
        });

        // Registrar no analytics
        await AnalyticsSystem.recordSale({
            userId: cartData.user.id,
            userTag: cartData.user.tag,
            product: cartData.product.titulo,
            plan: cartData.subproduct.nome,
            price: `R$ ${finalPrice.toFixed(2)}`,
            paymentMethod: 'balance'
        });
        
        await Logger.paymentConfirmed({
            userId: cartData.user.id,
            userTag: cartData.user.tag,
            product: cartData.product.titulo,
            plan: cartData.subproduct.nome,
            price: `R$ ${finalPrice.toFixed(2)}`,
            paymentMethod: 'SALDO',
            txid: Utils.generateTransactionId(),
            keyDelivered,
            discounts: cartData.pricingInfo.discounts,
            deliveredKey: deliveryResult.key
        });
        
        await Products.updateSalesStats(cartData.productId, finalPrice);
        
        if (await Resellers.isReseller(cartData.user.id)) {
            await Resellers.updateStats(cartData.user.id, finalPrice);
        }
        
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildBalancePaymentSuccess(
                cartData.user, 
                cartData.product, 
                cartData.subproduct, 
                `R$ ${finalPrice.toFixed(2)}`, 
                finalPrice, 
                remainingBalance
            )]
        });
        
        await interaction.editReply({ content: '✅ Pagamento processado com sucesso!' });
        
        global.cartDataMap?.delete(channelId);
        
        setTimeout(async () => {
            try {
                if (interaction.channel && !interaction.channel.deleted) {
                    await interaction.channel.delete('Compra finalizada com saldo');
                }
            } catch (error) {
                console.error('Erro fechando canal:', error);
            }
        }, 30000);
        
    } catch (error) {
        console.error('❌ Erro finalizando compra com saldo:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handleFinalizePurchase(interaction, action) {
    const parts = action.split('_');
    const channelId = parts[2];
    
    try {
        const cartData = global.cartDataMap?.get(channelId);
        if (!cartData) {
            await Utils.safeReply(interaction, { content: '❌ Dados do carrinho não encontrados.', ephemeral: true });
            return;
        }
        
        // Verificar estoque novamente
        if (cartData.stockAvailable === 0) {
            await Utils.safeReply(interaction, { content: '❌ Produto esgotado.', ephemeral: true });
            return;
        }
        
        const finalPrice = cartData.pricingInfo.finalPrice;
        const userBalance = await BalanceSystem.getBalance(interaction.user.id);
        
        if (cartData.useBalance && userBalance > 0) {
            const balanceToUse = Math.min(userBalance, finalPrice);
            const remainingPrice = finalPrice - balanceToUse;
            
            if (remainingPrice > 0) {
                await handleMixedPayment(interaction, cartData, balanceToUse, remainingPrice);
            } else {
                await handleFinalizeBalance(interaction, action);
            }
        } else {
            await Utils.safeReply(interaction, { content: '✅ Prossiga com o pagamento usando as instruções acima.', ephemeral: true });
        }
        
    } catch (error) {
        console.error('❌ Erro finalizando compra:', error);
        await Utils.safeReply(interaction, { content: `❌ Erro: ${error.message}`, ephemeral: true });
    }
}

async function handleMixedPayment(interaction, cartData, balanceToUse, remainingPrice) {
    try {
        await Utils.safeReply(interaction, { content: '🔄 Configurando pagamento misto...', ephemeral: true });
        
        if (cartData.paymentMethod === 'pix') {
            if (efi && process.env.PIX_KEY) {
                const pixData = await PIX.createCharge(remainingPrice, `${cartData.product.titulo} - ${cartData.subproduct.nome} (Pagamento Misto)`);
                
                const mixedPaymentData = {
                    ...cartData,
                    balanceToUse: balanceToUse,
                    remainingPrice: remainingPrice,
                    pixData: pixData,
                    isMixed: true
                };
                
                global.cartDataMap.set(interaction.channel.id, mixedPaymentData);
                
                const qrFileName = `mixed_pix_${pixData.txid}_${Date.now()}.png`;
                const qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
                const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
                
                await interaction.channel.send({
                    flags: ['IsComponentsV2'],
                    components: [ComponentBuilder.buildMixedPaymentInstructions(
                        balanceToUse, 
                        remainingPrice, 
                        cartData.product.titulo, 
                        cartData.subproduct.nome,
                        qrFileName,
                        pixData.pixCopiaECola
                    )],
                    files: [qrAttachment]
                });
                
                PIX.monitorMixedPayment(
                    pixData.txid, 
                    interaction.channel.id, 
                    cartData.user.id, 
                    cartData.user.tag, 
                    cartData.product.titulo, 
                    cartData.subproduct.nome, 
                    balanceToUse,
                    remainingPrice,
                    cartData.paymentMethod
                );
                
                await interaction.editReply({ content: '✅ Pagamento misto configurado! Pague o valor restante via PIX.' });
            } else {
                await interaction.editReply({ content: '❌ PIX não disponível para pagamento misto.' });
            }
        } else {
            const walletAddress = Utils.getWalletAddress(cartData.paymentMethod);
            const cryptoAmount = Utils.calculateCryptoPrice(remainingPrice, cartData.paymentMethod);
            
            const components = [
                {
                    type: 12,
                    items: [{ media: { url: 'https://media.discordapp.net/attachments/1300027105735868448/1379483827918999562/Compre-aqui.png?ex=68445c6e&is=68430aee&hm=019eb93543114db2917ba2708338f6484f15d5aaabda18609ddb2e89e3f22386&=&format=webp&quality=lossless' } }]
                },
                { type: 10, content: `# 💰 Pagamento Misto - Saldo + ${Utils.getPaymentDisplay(cartData.paymentMethod)}` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '> **Pagamento híbrido configurado!** Parte será debitada do seu saldo e o restante via criptomoeda.' },
                { type: 14, divider: false, spacing: 1 },
                { type: 10, content: `**💰 Saldo Usado:** R$ ${balanceToUse.toFixed(2)}\n**💳 Crypto Restante:** ${cryptoAmount}\n**💵 Equivalente:** R$ ${remainingPrice.toFixed(2)}\n\n**📬 Endereço da Carteira:**\n\`\`\`${walletAddress}\`\`\`` },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: '⚠️ **Importante:** Envie apenas o valor exato. Entre em contato após realizar o pagamento crypto!' }
            ];
            
            await interaction.channel.send({
                flags: ['IsComponentsV2'],
                components: [{ type: 17, components }]
            });
            
            await interaction.editReply({ content: '✅ Pagamento misto configurado! Pague o valor restante via crypto.' });
        }
        
    } catch (error) {
        console.error('❌ Erro configurando pagamento misto:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handleCancelOrder(interaction, action) {
    const channelId = action.includes('cancel_order_') ? 
        action.split('_')[2] : 
        interaction.channel.id;
    
    const embed = new EmbedBuilder()
        .setTitle('❌ Pedido Cancelado')
        .setDescription('Canal será fechado em alguns segundos.')
        .setColor('#ff0000');

    await Utils.safeReply(interaction, { embeds: [embed] });

    for (const [txid, pixData] of pixPayments.entries()) {
        if (pixData.channelId === channelId || pixData.channelId === interaction.channel.id) {
            clearInterval(pixData.interval);
            pixPayments.delete(txid);
        }
    }

    setTimeout(async () => {
        try {
            if (interaction.channel && !interaction.channel.deleted) {
                await interaction.channel.delete('Pedido cancelado');
            }
        } catch (error) {
            console.error('Erro deletando canal:', error);
        }
    }, 5000);
}

// ===== STOCK HANDLERS =====
async function handleStockProductSelect(interaction) {
    const productId = interaction.values[0];
    const products = await Products.load();
    const product = products[productId];
    const stock = await StockSystem.getStock(productId);

    if (!product?.subprodutos) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado ou sem planos.', ephemeral: true });
        return;
    }

    const options = [];
    
    for (let index = 0; index < Math.min(product.subprodutos.length, 25); index++) {
        const sub = product.subprodutos[index];
        const availableStock = stock[index] ? stock[index].length : 0;
        
        options.push({
            label: sub.nome,
            value: `${productId}|${index}`,
            description: `R$ ${sub.preco.toFixed(2)} • ${availableStock} keys no estoque`
        });
    }

    const productInterface = ComponentBuilder.buildStockProductInterface(product, productId, options);

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [productInterface]
    });
}

async function handleStockSubproductSelect(interaction) {
    const [productId, subIndex] = interaction.values[0].split('|');
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[parseInt(subIndex)];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto ou plano não encontrado.', ephemeral: true });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`add_stock_modal--${productId}--${subIndex}`)
        .setTitle(`📦 Adicionar Estoque - ${subproduct.nome}`);

    const keysInput = new TextInputBuilder()
        .setCustomId('keys_input')
        .setLabel('Keys (uma por linha)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('key1\nkey2\nkey3\noutra@key.com:senha123')
        .setRequired(true)
        .setMaxLength(4000);

    modal.addComponents(new ActionRowBuilder().addComponents(keysInput));
    await interaction.showModal(modal);
}

async function handleAddStockModal(interaction) {
    const customId = interaction.customId;
    const parts = customId.split('--');
    
    if (parts.length !== 3) {
        await Utils.safeReply(interaction, { content: '❌ Erro no formato do modal.', ephemeral: true });
        return;
    }
    
    const productId = parts[1];
    const subIndex = parseInt(parts[2]);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        console.error(`❌ Debug - ProductId: ${productId}, SubIndex: ${subIndex}, Product exists: ${!!product}, Subproduct exists: ${!!subproduct}`);
        await Utils.safeReply(interaction, { content: `❌ Produto ou plano não encontrado.\nDebug: ProductId: ${productId}, SubIndex: ${subIndex}`, ephemeral: true });
        return;
    }
    
    const keysInput = interaction.fields.getTextInputValue('keys_input').trim();
    
    if (!keysInput) {
        await Utils.safeReply(interaction, { content: '❌ Nenhuma key fornecida.', ephemeral: true });
        return;
    }
    
    const keys = keysInput
        .split('\n')
        .map(key => key.trim())
        .filter(key => key.length > 0);
    
    if (keys.length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Nenhuma key válida encontrada.', ephemeral: true });
        return;
    }
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Adicionando keys ao estoque...', ephemeral: true });
        
        const newTotal = await StockSystem.addStock(productId, subIndex, keys);
        
        await interaction.editReply({
            content: '',
            embeds: [],
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStockAdded(product.titulo, subproduct.nome, keys.length, newTotal)]
        });
        
        console.log(`📦 Estoque adicionado via interface: ${product.titulo} - ${subproduct.nome} (+${keys.length} keys)`);
        
    } catch (error) {
        console.error('❌ Erro adicionando estoque via interface:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handleBackToStockProducts(interaction) {
    const products = await Products.load();
    
    if (Object.keys(products).length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Nenhum produto disponível.', ephemeral: true });
        return;
    }

    const stockInterface = ComponentBuilder.buildStockInterface();
    
    const productOptions = Object.entries(products)
        .filter(([id, product]) => product.subprodutos?.length > 0)
        .slice(0, 25)
        .map(([id, product]) => ({
            label: product.titulo,
            value: id,
            description: `${product.subprodutos.length} planos disponíveis`
        }));

    stockInterface.components[7].components[0].options = productOptions;

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [stockInterface]
    });
}

async function handleAddStockButton(interaction) {
    const productId = interaction.customId.replace('add_stock_to_', '');
    const products = await Products.load();
    const product = products[productId];
    const stock = await StockSystem.getStock(productId);

    if (!product?.subprodutos) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado ou sem planos.', ephemeral: true });
        return;
    }

    const options = [];
    
    for (let index = 0; index < Math.min(product.subprodutos.length, 25); index++) {
        const sub = product.subprodutos[index];
        const availableStock = stock[index] ? stock[index].length : 0;
        
        options.push({
            label: sub.nome,
            value: `${productId}|${index}`,
            description: `R$ ${sub.preco.toFixed(2)} • ${availableStock} keys no estoque`
        });
    }

    const productInterface = ComponentBuilder.buildStockProductInterface(product, productId, options);

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [productInterface]
    });
}

// ===== NEW STOCK BUTTON HANDLERS =====
async function handleBackToStockMenu(interaction) {
    const stockInterface = ComponentBuilder.buildStockInterface();
    
    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [stockInterface]
    });
}

async function handleBackToRemoveStockProducts(interaction) {
    const stockSummary = await StockSystem.getStockSummary();
    
    if (Object.keys(stockSummary).length === 0) {
        await interaction.update({ 
            content: '❌ Nenhum produto com estoque encontrado.',
            components: []
        });
        return;
    }

    const productOptions = Object.entries(stockSummary)
        .slice(0, 25)
        .map(([productId, data]) => {
            const totalStock = Object.values(data.subproducts).reduce((sum, sub) => sum + sub.available, 0);
            return {
                label: data.title,
                value: productId,
                description: `${totalStock} keys disponíveis`
            };
        });

    const removeInterface = ComponentBuilder.buildRemoveStockInterface();
    removeInterface.components[7].components[0].options = productOptions;

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [removeInterface]
    });
}

async function handleRefreshStockMonitor(interaction) {
    const stockSummary = await StockSystem.getStockSummary();
    
    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [ComponentBuilder.buildStockMonitor(stockSummary)]
    });
}

async function handleEmergencyAddStock(interaction) {
    const parts = interaction.customId.split('_');
    const productId = parts[3];
    const subIndex = parseInt(parts[4]);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`add_stock_modal--${productId}_${subIndex}`)
        .setTitle(`🆘 EMERGÊNCIA - ${subproduct.nome}`);

    const keysInput = new TextInputBuilder()
        .setCustomId('keys_input')
        .setLabel('Keys (uma por linha) - URGENTE!')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('key1\nkey2\nkey3\n...')
        .setRequired(true)
        .setMaxLength(4000);

    modal.addComponents(new ActionRowBuilder().addComponents(keysInput));
    await interaction.showModal(modal);
}

async function handleQuickAddStock(interaction) {
    const parts = interaction.customId.split('_');
    const productId = parts[3];
    const subIndex = parseInt(parts[4]);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`add_stock_modal--${productId}_${subIndex}`)
        .setTitle(`📦 Reabastecer - ${subproduct.nome}`);

    const keysInput = new TextInputBuilder()
        .setCustomId('keys_input')
        .setLabel('Keys para adicionar (uma por linha)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('key1\nkey2\nkey3\n...')
        .setRequired(true)
        .setMaxLength(4000);

    modal.addComponents(new ActionRowBuilder().addComponents(keysInput));
    await interaction.showModal(modal);
}

async function handleViewAllStock(interaction) {
    const stockSummary = await StockSystem.getStockSummary();
    
    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [ComponentBuilder.buildStockMonitor(stockSummary)]
    });
}

async function handleEmergencyRestock(interaction) {
    const productId = interaction.customId.replace('emergency_restock_', '');
    const products = await Products.load();
    const product = products[productId];
    
    if (!product?.subprodutos) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }

    const options = [];
    
    for (let index = 0; index < Math.min(product.subprodutos.length, 25); index++) {
        const sub = product.subprodutos[index];
        options.push({
            label: sub.nome,
            value: `${productId}|${index}`,
            description: `R$ ${sub.preco.toFixed(2)} - REABASTECER URGENTE`
        });
    }

    const productInterface = ComponentBuilder.buildStockProductInterface(product, productId, options);
    productInterface.components[0].content = `# 🆘 REABASTECIMENTO URGENTE - ${product.titulo}`;
    productInterface.components[2].content = '> **PRODUTO SEM ESTOQUE!** Selecione o plano para reabastecimento imediato.';

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [productInterface]
    });
}

// ===== NEW STOCK HANDLERS =====
async function handleStockActionSelect(interaction) {
    const action = interaction.values[0];
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Carregando...', ephemeral: true });
        
        switch (action) {
            case 'add_stock':
                await handleAddStockAction(interaction);
                break;
            case 'remove_stock':
                await handleRemoveStockAction(interaction);
                break;
            case 'monitor_stock':
                await handleMonitorStockAction(interaction);
                break;
            case 'check_product':
                await handleCheckProductAction(interaction);
                break;
            case 'configure_alerts':
                await handleConfigureAlertsAction(interaction);
                break;
            default:
                await interaction.editReply({ content: '❌ Ação não reconhecida.' });
        }
        
    } catch (error) {
        console.error('❌ Erro na ação de estoque:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

async function handleAddStockAction(interaction) {
    const products = await Products.load();
    
    if (Object.keys(products).length === 0) {
        await interaction.editReply({ content: '❌ Nenhum produto disponível. Crie produtos primeiro com `/createproduct`.' });
        return;
    }

    const productOptions = Object.entries(products)
        .filter(([id, product]) => product.subprodutos?.length > 0)
        .slice(0, 25)
        .map(([id, product]) => ({
            label: product.titulo,
            value: id,
            description: `${product.subprodutos.length} planos disponíveis`
        }));

    if (productOptions.length === 0) {
        await interaction.editReply({ content: '❌ Nenhum produto com planos encontrado.' });
        return;
    }

    const stockInterface = ComponentBuilder.buildStockInterface();
    stockInterface.components[7].components[0].custom_id = 'stock_product_select';
    stockInterface.components[7].components[0].options = productOptions;

    await interaction.editReply({
        content: '',
        flags: ['IsComponentsV2'],
        components: [stockInterface]
    });
}

async function handleRemoveStockAction(interaction) {
    const products = await Products.load();
    const stockSummary = await StockSystem.getStockSummary();
    
    if (Object.keys(stockSummary).length === 0) {
        await interaction.editReply({ content: '❌ Nenhum produto com estoque encontrado.' });
        return;
    }

    const productOptions = Object.entries(stockSummary)
        .slice(0, 25)
        .map(([productId, data]) => {
            const totalStock = Object.values(data.subproducts).reduce((sum, sub) => sum + sub.available, 0);
            return {
                label: data.title,
                value: productId,
                description: `${totalStock} keys disponíveis`
            };
        });

    const removeInterface = ComponentBuilder.buildRemoveStockInterface();
    removeInterface.components[7].components[0].options = productOptions;

    await interaction.editReply({
        content: '',
        flags: ['IsComponentsV2'],
        components: [removeInterface]
    });
}

async function handleMonitorStockAction(interaction) {
    const stockSummary = await StockSystem.getStockSummary();
    
    await interaction.editReply({
        content: '',
        flags: ['IsComponentsV2'],
        components: [ComponentBuilder.buildStockMonitor(stockSummary)]
    });
}

async function handleCheckProductAction(interaction) {
    const products = await Products.load();
    
    if (Object.keys(products).length === 0) {
        await interaction.editReply({ content: '❌ Nenhum produto disponível.' });
        return;
    }

    const productOptions = Object.entries(products)
        .slice(0, 25)
        .map(([id, product]) => ({
            label: product.titulo,
            value: id,
            description: product.descricao.substring(0, 100)
        }));

    const checkInterface = {
        type: 17,
        components: [
            { type: 10, content: '# 🔍 Verificar Produto Específico' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Selecione um produto** para ver informações detalhadas do estoque.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 1, components: [{ type: 3, custom_id: 'check_specific_product', placeholder: 'Escolha um produto para verificar', options: productOptions }] },
            { type: 1, components: [{ type: 2, style: 2, label: '← Voltar ao Menu', custom_id: 'back_to_stock_menu' }] }
        ]
    };

    await interaction.editReply({
        content: '',
        flags: ['IsComponentsV2'],
        components: [checkInterface]
    });
}

async function handleConfigureAlertsAction(interaction) {
    const alertsInterface = {
        type: 17,
        components: [
            { type: 10, content: '# ⚙️ Configurar Alertas de Estoque' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '> **Sistema de alertas automáticos.** Configure quando receber notificações sobre estoque baixo.' },
            { type: 14, divider: false, spacing: 1 },
            { type: 10, content: '**Configurações Atuais:**\n• **Alerta crítico:** Quando estoque = 0\n• **Alerta baixo:** Quando estoque ≤ 3\n• **Canal de alertas:** <#1267993296836366366>\n• **Menções:** Ativadas para administradores' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: '**Próximas funcionalidades:**\n• Configuração de limites personalizados\n• Alertas por produto específico\n• Relatórios de estoque programados' },
            { type: 14, divider: true, spacing: 1 },
            { type: 1, components: [{ type: 2, style: 2, label: '← Voltar ao Menu', custom_id: 'back_to_stock_menu' }] }
        ]
    };

    await interaction.editReply({
        content: '',
        flags: ['IsComponentsV2'],
        components: [alertsInterface]
    });
}

async function handleRemoveStockProductSelect(interaction) {
    const productId = interaction.values[0];
    const products = await Products.load();
    const product = products[productId];
    const stock = await StockSystem.getStock(productId);

    if (!product?.subprodutos) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado ou sem planos.', ephemeral: true });
        return;
    }

    const options = [];
    
    for (let index = 0; index < Math.min(product.subprodutos.length, 25); index++) {
        const sub = product.subprodutos[index];
        const availableStock = stock[index] ? stock[index].length : 0;
        
        if (availableStock > 0) {
            options.push({
                label: sub.nome,
                value: `${productId}|${index}`,
                description: `${availableStock} keys disponíveis para remoção`
            });
        }
    }

    if (options.length === 0) {
        await Utils.safeReply(interaction, { content: '❌ Este produto não possui estoque para remoção.', ephemeral: true });
        return;
    }

    const productInterface = ComponentBuilder.buildRemoveStockProductInterface(product, productId, options);

    await interaction.update({
        flags: ['IsComponentsV2'],
        components: [productInterface]
    });
}

async function handleRemoveStockSubproductSelect(interaction) {
    const value = interaction.values[0];
    const [productId, subIndexStr] = value.split('|');
    const subIndex = parseInt(subIndexStr);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto ou plano não encontrado.', ephemeral: true });
        return;
    }
    
    const availableStock = await StockSystem.getAvailableCount(productId, subIndex);
    
    if (availableStock === 0) {
        await Utils.safeReply(interaction, { content: '❌ Este plano não possui estoque para remoção.', ephemeral: true });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`remove_stock_modal_${productId}_${subIndex}`)
        .setTitle(`Remover Estoque - ${subproduct.nome}`);

    const quantityInput = new TextInputBuilder()
        .setCustomId('quantity_input')
        .setLabel('Quantidade a Remover')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`Digite um número entre 1 e ${availableStock}`)
        .setRequired(true)
        .setMaxLength(10);

    const confirmInput = new TextInputBuilder()
        .setCustomId('confirm_input')
        .setLabel('Confirmação (digite "CONFIRMAR")')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Digite CONFIRMAR para prosseguir')
        .setRequired(true)
        .setMaxLength(10);

    modal.addComponents(
        new ActionRowBuilder().addComponents(quantityInput),
        new ActionRowBuilder().addComponents(confirmInput)
    );

    await interaction.showModal(modal);
}

async function handleRemoveStockModal(interaction) {
    const parts = interaction.customId.split('_');
    const productId = parts[3];
    const subIndex = parseInt(parts[4]);
    
    const products = await Products.load();
    const product = products[productId];
    const subproduct = product?.subprodutos[subIndex];
    
    if (!product || !subproduct) {
        await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
        return;
    }
    
    const quantityStr = interaction.fields.getTextInputValue('quantity_input').trim();
    const confirmation = interaction.fields.getTextInputValue('confirm_input').trim();
    
    if (confirmation.toUpperCase() !== 'CONFIRMAR') {
        await Utils.safeReply(interaction, { content: '❌ Confirmação inválida. A remoção foi cancelada.', ephemeral: true });
        return;
    }
    
    const quantity = parseInt(quantityStr);
    if (isNaN(quantity) || quantity <= 0) {
        await Utils.safeReply(interaction, { content: '❌ Quantidade inválida. Use apenas números positivos.', ephemeral: true });
        return;
    }
    
    const availableStock = await StockSystem.getAvailableCount(productId, subIndex);
    if (quantity > availableStock) {
        await Utils.safeReply(interaction, { content: `❌ Quantidade solicitada (${quantity}) maior que o estoque disponível (${availableStock}).`, ephemeral: true });
        return;
    }
    
    try {
        await Utils.safeReply(interaction, { content: '🔄 Removendo keys do estoque...', ephemeral: true });
        
        const removedKeys = await StockSystem.removeStock(productId, subIndex, quantity);
        const remainingStock = await StockSystem.getAvailableCount(productId, subIndex);
        
        await interaction.editReply({
            content: '',
            embeds: [],
            flags: ['IsComponentsV2'],
            components: [ComponentBuilder.buildStockRemoved(product.titulo, subproduct.nome, quantity, remainingStock, removedKeys)]
        });
        
        console.log(`➖ Estoque removido via interface: ${product.titulo} - ${subproduct.nome} (-${quantity} keys)`);
        
    } catch (error) {
        console.error('❌ Erro removendo estoque via interface:', error);
        await interaction.editReply({ content: `❌ Erro: ${error.message}` });
    }
}

// ===== ERROR HANDLING =====
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    
    for (const [txid, pixData] of pixPayments.entries()) {
        clearInterval(pixData.interval);
    }
    for (const [txid, pixData] of customPixPayments.entries()) {
        clearInterval(pixData.interval);
    }
    
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('🔄 Encerrando...');
    
    for (const [txid, pixData] of pixPayments.entries()) {
        clearInterval(pixData.interval);
    }
    for (const [txid, pixData] of customPixPayments.entries()) {
        clearInterval(pixData.interval);
    }
    
    pixPayments.clear();
    customPixPayments.clear();
    
    if (global.cartDataMap) {
        global.cartDataMap.clear();
    }
    
    try {
        for (const filePath of tempFiles) {
            if (fsSync.existsSync(filePath)) {
                await fs.unlink(filePath);
            }
        }
    } catch (error) {
        console.error('Erro limpando arquivos:', error);
    }
    
    client.destroy();
    console.log('✅ Bot encerrado');
    process.exit(0);
});

// ===== COMMAND HANDLERS =====

async function cmdUpdates(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await Utils.safeReply(interaction, { content: '❌ Você não tem permissão para usar este comando.', ephemeral: true });
        return;
    }
    
    try {
        // Criar modal para editar a embed de updates
        const modal = new ModalBuilder()
            .setCustomId('updates_modal')
            .setTitle('📢 Configurar Embed de Updates');

        // Campo para URL da imagem
        const imageUrlInput = new TextInputBuilder()
            .setCustomId('updates_image_url')
            .setLabel('🖼️ URL da Imagem')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://exemplo.com/imagem.png')
            .setValue('https://media.discordapp.net/attachments/1376935207458046012/1404140579713060924/image.png?ex=689cbe51&is=689b6cd1&hm=7136b8ebb043e7fc5128c3e8481619718fd2ddabd51f1ab38629920478d0791c&=&format=webp&quality=lossless&width=1536&height=864')
            .setRequired(true);

        // Campo para mensagem
        const messageInput = new TextInputBuilder()
            .setCustomId('updates_message')
            .setLabel('📝 Mensagem da Embed')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Digite sua mensagem aqui...')
            .setValue('MENSAGEM FICA AQUI')
            .setRequired(true);

        // Campo para cor da borda
        const colorInput = new TextInputBuilder()
            .setCustomId('updates_color')
            .setLabel('🎨 Cor da Borda (número hexadecimal)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('2945024 (azul)')
            .setValue('2945024')
            .setRequired(true);

        // Campo para botões (JSON formatado)
        const buttonsInput = new TextInputBuilder()
            .setCustomId('updates_buttons')
            .setLabel('🔗 Botões (formato JSON)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('[{"label":"Botão 1","url":"https://exemplo.com"},{"label":"Botão 2","url":"https://exemplo2.com"}]')
            .setValue('[{"label":"Herbivorous Cat","url":"https://google.com"},{"label":"Scaly Pigeon","url":"https://google.com"}]')
            .setRequired(true);

        // Adicionar campos ao modal
        const firstActionRow = new ActionRowBuilder().addComponents(imageUrlInput);
        const secondActionRow = new ActionRowBuilder().addComponents(messageInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(colorInput);
        const fourthActionRow = new ActionRowBuilder().addComponents(buttonsInput);

        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow, fourthActionRow);

        await interaction.showModal(modal);
        
    } catch (error) {
        console.error('❌ Erro abrindo modal de updates:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro ao abrir modal de configuração.', ephemeral: true });
    }
}

async function handleUpdatesModal(interaction) {
    try {
        // Extrair dados do modal
        const imageUrl = interaction.fields.getTextInputValue('updates_image_url');
        const message = interaction.fields.getTextInputValue('updates_message');
        const color = interaction.fields.getTextInputValue('updates_color');
        const buttonsJson = interaction.fields.getTextInputValue('updates_buttons');

        // Validar e parsear os botões
        let buttons;
        try {
            buttons = JSON.parse(buttonsJson);
            if (!Array.isArray(buttons)) {
                throw new Error('Botões devem ser um array');
            }
        } catch (error) {
            await Utils.safeReply(interaction, { 
                content: '❌ Formato de botões inválido. Use o formato JSON correto.', 
                ephemeral: true 
            });
            return;
        }

        // Validar cor
        const accentColor = parseInt(color);
        if (isNaN(accentColor)) {
            await Utils.safeReply(interaction, { 
                content: '❌ Cor inválida. Use um número válido.', 
                ephemeral: true 
            });
            return;
        }

        // Construir componentes dos botões
        const buttonComponents = buttons.map(button => ({
            type: 2,
            style: 5,
            label: button.label,
            emoji: null,
            disabled: false,
            url: button.url
        }));

        // Enviar embed de atualizações no formato Components V2
        await interaction.reply({
            flags: ['IsComponentsV2'],
            components: [{
                type: 17,
                accent_color: accentColor,
                spoiler: false,
                components: [
                    {
                        type: 12,
                        items: [
                            {
                                media: {
                                    url: imageUrl
                                },
                                description: null,
                                spoiler: false
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: message
                    },
                    {
                        type: 1,
                        components: buttonComponents
                    }
                ]
            }]
        });

        console.log(`📢 Updates enviado por ${interaction.user.tag} no canal ${interaction.channel.name}`);
        console.log(`📋 Configuração: Imagem=${imageUrl}, Mensagem="${message}", Cor=${accentColor}, Botões=${buttons.length}`);

    } catch (error) {
        console.error('❌ Erro processando modal de updates:', error);
        await Utils.safeReply(interaction, { 
            content: '❌ Erro ao processar configuração. Verifique os dados inseridos.', 
            ephemeral: true 
        });
    }
}

async function cmdPix(interaction) {
    try {
        const valor = interaction.options.getNumber('valor');
        const usuario = interaction.options.getUser('usuario');
        const descricao = interaction.options.getString('descricao') || `Pagamento personalizado para ${usuario.username}`;
        
        // Gerar ID único para o pagamento
        const paymentId = Utils.generateTransactionId();
        const expiresAt = Date.now() + (60 * 60 * 1000); // 1 hora
        
        // Criar pagamento personalizado
        const payment = await CustomPaymentSystem.create(
            usuario.id,
            usuario.tag,
            valor,
            descricao,
            interaction.channel.id
        );
        
        // Criar pagamento PIX real via EFI Pay
        let pixData = null;
        let qrFileName = null;
        let qrFilePath = null;
        
        if (efi && process.env.PIX_KEY) {
            try {
                // Criar cobrança PIX via EFI
                pixData = await PIX.createCharge(valor, descricao);
                
                // Gerar QR Code com o código real do EFI
                qrFileName = `pix_qr_${payment.id}_${Date.now()}.png`;
                qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
                
                console.log(`✅ QR Code EFI gerado: ${qrFileName}`);
            } catch (error) {
                console.error('❌ Erro gerando QR Code EFI:', error);
                // Fallback para código simulado
                pixData = {
                    pixCopiaECola: `00020126580014br.gov.bcb.pix0136${paymentId}520400005303986540510.005802BR5913Root@Unk Store6009Sao Paulo62070503***6304ABCD`
                };
            }
        } else {
            // Fallback se EFI não estiver configurado
            pixData = {
                pixCopiaECola: `00020126580014br.gov.bcb.pix0136${paymentId}520400005303986540510.005802BR5913Root@Unk Store6009Sao Paulo62070503***6304ABCD`
            };
        }
        
        const pixCode = pixData.pixCopiaECola;
        
        // Salvar dados do EFI no pagamento
        const payments = await CustomPaymentSystem.load();
        const paymentIndex = payments.findIndex(p => p.id === payment.id);
        if (paymentIndex !== -1) {
            payments[paymentIndex].pixCode = pixCode;
            if (pixData && pixData.txid) {
                payments[paymentIndex].efiTxid = pixData.txid;
            }
            await CustomPaymentSystem.save(payments);
        }
        
        // Criar embed do pagamento (minimalista)
        const pixEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 5,
                        label: "Nosso site!",
                        emoji: null,
                        disabled: false,
                        url: "https://rootunk.store"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 💰 Pagamento PIX"
                        }
                    ]
                },
                {
                    type: 10,
                    content: `👤 <@${usuario.id}> • 💵 R$ ${valor.toFixed(2)}\n📋 ${descricao}\n\n📌 Aguardando pagamento...`
                }
            ]
        };
        
        // Preparar componentes para envio
        const components = [pixEmbed];
        
        // Segunda embed com QR Code e código PIX (se QR Code foi gerado)
        if (qrFileName && qrFilePath) {
            const pixDetailsEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 12,
                        items: [
                            {
                                media: {
                                    url: `attachment://${qrFileName}`
                                },
                                description: null,
                                spoiler: false
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: `🔗 **PIX Copia e Cola:**\n\`\`\`\n${pixCode}\n\`\`\`\n\n🕒 Expira <t:${Math.floor(expiresAt/1000)}:R>`
                    }
                ]
            };
            components.push(pixDetailsEmbed);
        } else {
            // Embed apenas com código PIX (sem QR Code)
            const pixCodeEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 10,
                        content: `🔗 **PIX Copia e Cola:**\n\`\`\`\n${pixCode}\n\`\`\`\n\n🕒 Expira <t:${Math.floor(expiresAt/1000)}:R>`
                    }
                ]
            };
            components.push(pixCodeEmbed);
        }
        
        // Preparar arquivos para envio
        const files = [];
        if (qrFileName && qrFilePath) {
            const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
            files.push(qrAttachment);
        }
        
        // Responder primeiro
        await Utils.safeReply(interaction, { 
            content: `✅ Pagamento PIX gerado!\n👤 Usuário: ${usuario.tag}\n💵 Valor: R$ ${valor.toFixed(2)}\n🆔 ID: \`${payment.id}\``, 
            ephemeral: true 
        });
        
        // Enviar embeds no canal
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: components,
            files: files
        });
        

        
        // Iniciar monitoramento do pagamento
        PIX.monitorCustomPayment(payment, interaction.channel.id);
        
        console.log(`💰 Pagamento PIX criado: ${usuario.tag} - R$ ${valor.toFixed(2)}`);
        
    } catch (error) {
        console.error('❌ Erro ao gerar pagamento PIX:', error);
        await Utils.safeReply(interaction, { 
            content: `❌ Erro ao gerar pagamento PIX: ${error.message}`, 
            ephemeral: true 
        });
    }
}

async function cmdTicket(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await Utils.safeReply(interaction, { content: '❌ Você não tem permissão para usar este comando.', ephemeral: true });
        return;
    }
    
    try {
        // Criar embed do painel de tickets usando ComponentBuilderV2
        const ticketEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 1,
                        label: "🎫 Abrir Ticket",
                        emoji: null,
                        disabled: false,
                        custom_id: "ticket_create"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🎫 Atendimento"
                        }
                    ]
                },
                {
                    type: 10,
                    content: "Seja bem-vindo(a) ao nosso sistema de suporte.\nPor meio deste canal, você terá contato direto com nossa equipe, garantindo um atendimento ágil, claro e eficiente."
                }
            ]
        };
        
        // Enviar no canal (não como resposta ephemeral)
        await interaction.channel.send({
            flags: ['IsComponentsV2'],
            components: [ticketEmbed]
        });
        
        // Responder apenas para confirmar (ephemeral)
        await Utils.safeReply(interaction, { 
            content: '✅ Painel de tickets criado com sucesso!',
            ephemeral: true 
        });
        
        console.log(`✅ Painel de tickets criado por ${interaction.user.tag} em #${interaction.channel.name}`);
        
    } catch (error) {
        console.error('❌ Erro no comando ticket:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro ao criar painel de tickets.', ephemeral: true });
    }
}

// ===== SISTEMA DE CARRINHO =====
// Armazenar dados do carrinho por canal
global.cartData = new Map();

class CartManager {
    static getCart(channelId) {
        if (!global.cartData.has(channelId)) {
            global.cartData.set(channelId, {
                items: [],
                paymentMethod: null,
                userId: null,
                total: 0
            });
        }
        return global.cartData.get(channelId);
    }
    
    static addItem(channelId, item) {
        const cart = this.getCart(channelId);
        const existingIndex = cart.items.findIndex(cartItem => 
            cartItem.productId === item.productId && cartItem.subIndex === item.subIndex
        );
        
        if (existingIndex >= 0) {
            cart.items[existingIndex].quantity += 1;
        } else {
            cart.items.push({
                ...item,
                quantity: 1
            });
        }
        
        this.calculateTotal(channelId);
        global.cartData.set(channelId, cart);
        return cart;
    }
    
    static removeItem(channelId, productId, subIndex) {
        const cart = this.getCart(channelId);
        const itemIndex = cart.items.findIndex(item => 
            item.productId === productId && item.subIndex === subIndex
        );
        
        if (itemIndex >= 0) {
            if (cart.items[itemIndex].quantity > 1) {
                cart.items[itemIndex].quantity -= 1;
            } else {
                cart.items.splice(itemIndex, 1);
            }
        }
        
        this.calculateTotal(channelId);
        global.cartData.set(channelId, cart);
        return cart;
    }
    
    static calculateTotal(channelId) {
        const cart = this.getCart(channelId);
        cart.total = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        return cart.total;
    }
    
    static setPaymentMethod(channelId, method) {
        const cart = this.getCart(channelId);
        cart.paymentMethod = method;
        global.cartData.set(channelId, cart);
    }
    
    static setUserId(channelId, userId) {
        const cart = this.getCart(channelId);
        cart.userId = userId;
        global.cartData.set(channelId, cart);
    }
    
    static clearCart(channelId) {
        global.cartData.delete(channelId);
    }
}

// ===== NOVOS HANDLERS PARA O CARRINHO =====

async function handleShoppingCartOpen(interaction) {
    try {
        const guild = interaction.guild;
        const user = interaction.user;
        
        // Verificar se o usuário já tem um carrinho ativo
        const existingCart = guild.channels.cache.find(ch => 
            ch.name.includes('carrinho-') && 
            ch.name.includes(user.username.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
        
        if (existingCart) {
            const cartExistsEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 9,
                        accessory: {
                            type: 2,
                            style: 5,
                            label: "🛒 Ir para Carrinho Existente",
                            emoji: null,
                            disabled: false,
                            url: `https://discord.com/channels/${guild.id}/${existingCart.id}`
                        },
                        components: [
                            {
                                type: 10,
                                content: "# ⚠️ Carrinho Já Existe!"
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: "Você já possui um carrinho ativo! Acesse o canal para continuar sua compra."
                    }
                ]
            };
            
            return await Utils.safeReply(interaction, {
                flags: ['IsComponentsV2'],
                components: [cartExistsEmbed],
                ephemeral: true
            });
        }
        
        // Buscar ou criar categoria para carrinhos
        let cartCategory = guild.channels.cache.find(ch => 
            ch.type === ChannelType.GuildCategory && ch.name === '🛒 CARRINHOS'
        );
        
        if (!cartCategory) {
            cartCategory = await guild.channels.create({
                name: '🛒 ┃ Cart',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: ['ViewChannel']
                    }
                ]
            });
        }
        
        // Criar canal exclusivo para o carrinho do usuário
        const channelName = `🛒-carrinho-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
        
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: cartCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: ['ViewChannel', 'SendMessages']
                },
                {
                    id: user.id,
                    allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                },
                // Permitir que admins vejam também
                ...guild.roles.cache
                    .filter(role => role.permissions.has(PermissionsBitField.Flags.Administrator))
                    .map(role => ({
                        id: role.id,
                        allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                    }))
            ]
        });

        // Inicializar carrinho e salvar ID do usuário
        CartManager.setUserId(channel.id, user.id);
        
        // Enviar embed do carrinho no canal criado
        const cartEmbed = ComponentBuilder.buildShoppingCart();
        
        // Enviar mensagem de boas-vindas em ComponentsV2
        const welcomeEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: `🎉 **Bem-vindo ao seu carrinho pessoal, ${user}!**\n\nEste canal foi criado exclusivamente para sua compra. Você pode navegar pelos produtos e finalizar sua compra aqui com total privacidade.\n\n⏰ **Atenção:** Este canal será deletado automaticamente em 1 hora se não houver atividade.`
                }
            ]
        };
        
        await channel.send({
            flags: ['IsComponentsV2'],
            components: [welcomeEmbed]
        });
        
        // Enviar embed do carrinho
        await channel.send({
            flags: ['IsComponentsV2'],
            components: [cartEmbed]
        });

        // Auto-deletar canal após 1 hora de inatividade
        setTimeout(async () => {
            try {
                // Verificar se o canal ainda existe
                const existingChannel = guild.channels.cache.get(channel.id);
                if (existingChannel) {
                    await existingChannel.send('⏰ **Tempo esgotado!** Este carrinho será deletado em 1 minuto por inatividade.');
                    
                    setTimeout(async () => {
                        try {
                            const finalCheck = guild.channels.cache.get(channel.id);
                            if (finalCheck) {
                                console.log(`⏰ Carrinho expirado por inatividade: ${finalCheck.name}`);
                                CartManager.clearCart(finalCheck.id); // Limpar dados do carrinho
                                await finalCheck.delete('Carrinho expirado por inatividade');
                            }
                        } catch (error) {
                            console.error('❌ Erro ao deletar canal expirado:', error);
                        }
                    }, 60000); // 1 minuto adicional
                }
            } catch (error) {
                console.error('❌ Erro na verificação de expiração do carrinho:', error);
            }
        }, 60 * 60 * 1000); // 1 hora

        // Log da criação do carrinho
        console.log(`🛒 Carrinho criado: ${channel.name} para ${user.tag} (${user.id})`);
        
        // Responder com ComponentsV2
        const cartCreatedEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: "# 🛒 Carrinho Criado!"
                },
                {
                    type: 10,
                    content: `Seu carrinho pessoal foi criado! Acesse o canal para finalizar sua compra.\n\n📋 **Próximos Passos:** Acesse o canal criado para continuar sua compra.\n⏰ **Tempo Limite:** 1 hora de inatividade`
                },
                {
                    type: 1,
                    components: [{
                        type: 2,
                        style: 5,
                        label: "🛒 Ir para Carrinho",
                        url: `https://discord.com/channels/${guild.id}/${channel.id}`
                    }]
                }
            ]
        };
        
        await Utils.safeReply(interaction, {
            flags: ['IsComponentsV2'],
            components: [cartCreatedEmbed],
            ephemeral: true
        });
        
    } catch (error) {
        console.error('❌ Erro ao criar carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro ao criar carrinho. Tente novamente.', ephemeral: true });
    }
}

async function handleBackToStore(interaction) {
    try {
        const channel = interaction.channel;
        
        // Verificar se é um canal de carrinho
        if (channel.name.includes('carrinho-')) {
            await Utils.safeReply(interaction, { 
                content: '🛒 **Fechando carrinho...** Este canal será deletado em 5 segundos.',
                ephemeral: true 
            });
            
            // Log da deleção manual
            console.log(`🗑️ Carrinho deletado manualmente: ${channel.name} por ${interaction.user.tag}`);
            
            // Aguardar 5 segundos e deletar o canal
            setTimeout(async () => {
                try {
                    CartManager.clearCart(channel.id); // Limpar dados do carrinho
                    await channel.delete('Carrinho fechado pelo usuário');
                } catch (error) {
                    console.error('❌ Erro ao deletar canal do carrinho:', error);
                }
            }, 5000);
        } else {
            await Utils.safeReply(interaction, { 
                content: '❌ Este comando só pode ser usado em canais de carrinho.',
                ephemeral: true 
            });
        }
    } catch (error) {
        console.error('❌ Erro ao fechar carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleCartPaymentSelect(interaction) {
    try {
        const selectedPayment = interaction.values[0];
        const channelId = interaction.channel.id;
        
        // Salvar método de pagamento no carrinho
        CartManager.setPaymentMethod(channelId, selectedPayment);
        
        // Carregar produtos disponíveis
        const products = await Products.load();
        const productArray = Object.entries(products).map(([id, product]) => ({
            id,
            ...product
        }));
        
        const cartEmbed = ComponentBuilder.buildShoppingCart(productArray, selectedPayment);
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [cartEmbed]
        });
    } catch (error) {
        console.error('❌ Erro ao selecionar pagamento no carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleCartProductSelect(interaction) {
    try {
        const paymentMethod = interaction.customId.split('_').pop();
        const productId = interaction.values[0];
        
        const products = await Products.load();
        const product = products[productId];
        
        if (!product) {
            await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
            return;
        }

        // Mostrar subprodutos para adicionar ao carrinho
        const stock = await StockSystem.getStock(productId);
        const subproductOptions = product.subprodutos.map((subproduct, index) => {
            const stockAvailable = stock && stock[index] ? stock[index].length : 0;
            const stockText = stockAvailable > 0 ? ` (${stockAvailable} disponível)` : ' (Esgotado)';
            const isInStock = stockAvailable > 0;
            return {
                label: subproduct.nome,
                value: `addcart_${productId}_${index}`,
                description: `R$ ${subproduct.preco.toFixed(2)}${stockText}`,
                isInStock
            };
        }).filter(option => option.isInStock);

        if (subproductOptions.length === 0) {
            await Utils.safeReply(interaction, { content: '❌ Este produto está temporariamente esgotado.', ephemeral: true });
            return;
        }

        const addToCartEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 10,
                    content: `# ${product.titulo}`
                },
                {
                    type: 10,
                    content: `**Selecione o plano que deseja adicionar ao carrinho:**`
                },
                {
                    type: 1,
                    components: [{
                        type: 3,
                        custom_id: 'add_to_cart_select',
                        placeholder: '🛒 Escolha o plano para adicionar',
                        options: subproductOptions
                    }]
                },
                {
                    type: 1,
                    components: [{
                        type: 2,
                        style: 4,
                        label: "Voltar aos Produtos",
                        custom_id: "back_to_product_list"
                    }]
                }
            ]
        };
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [addToCartEmbed]
        });
    } catch (error) {
        console.error('❌ Erro ao selecionar produto no carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

// ===== NOVOS HANDLERS DO CARRINHO =====

async function handleAddToCartSelect(interaction) {
    try {
        const value = interaction.values[0];
        console.log(`🔍 Debug - Value recebido: ${value}`);
        
        // Parse mais seguro: addcart_productId_subIndex
        const parts = value.split('_');
        if (parts.length < 3 || parts[0] !== 'addcart') {
            console.error(`❌ Formato inválido do value: ${value}`);
            await Utils.safeReply(interaction, { content: '❌ Formato inválido.', ephemeral: true });
            return;
        }
        
        const productId = parts.slice(1, -1).join('_'); // Reconstrói productId mesmo se tiver _
        const subIndex = parts[parts.length - 1]; // Último elemento é sempre o index
        const channelId = interaction.channel.id;
        
        console.log(`🔍 Debug - ProductID: ${productId}, SubIndex: ${subIndex}`);
        
        const products = await Products.load();
        console.log(`🔍 Debug - Produtos disponíveis:`, Object.keys(products));
        const product = products[productId];
        
        if (!product) {
            console.error(`❌ Produto não encontrado: ${productId}`);
            await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
            return;
        }
        
        if (!product.subprodutos || !product.subprodutos[parseInt(subIndex)]) {
            console.error(`❌ Subproduto não encontrado: ${productId}[${subIndex}]`);
            await Utils.safeReply(interaction, { content: '❌ Plano não encontrado.', ephemeral: true });
            return;
        }
        
        const subproduct = product.subprodutos[parseInt(subIndex)];
        
        // Adicionar item ao carrinho
        const item = {
            productId,
            subIndex: parseInt(subIndex),
            productTitle: product.titulo,
            subproductName: subproduct.nome,
            price: subproduct.preco
        };
        
        CartManager.addItem(channelId, item);
        const cart = CartManager.getCart(channelId);
        
        // Mostrar resumo do carrinho atualizado
        const cartSummary = ComponentBuilder.buildCartSummary(cart);
        
        if (cartSummary) {
            await interaction.update({
                flags: ['IsComponentsV2'],
                components: cartSummary
            });
        } else {
            await Utils.safeReply(interaction, { content: '❌ Erro ao exibir carrinho.', ephemeral: true });
        }
        
        console.log(`🛒 Item adicionado ao carrinho: ${product.titulo} - ${subproduct.nome} (Canal: ${channelId})`);
        
    } catch (error) {
        console.error('❌ Erro ao adicionar item ao carrinho:', error);
        console.error('❌ Stack trace:', error.stack);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleAddMoreProducts(interaction) {
    try {
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        if (!cart.paymentMethod) {
            await Utils.safeReply(interaction, { content: '❌ Selecione um método de pagamento primeiro.', ephemeral: true });
            return;
        }
        
        // Carregar produtos disponíveis
        const products = await Products.load();
        const productArray = Object.entries(products).map(([id, product]) => ({
            id,
            ...product
        }));
        
        const cartEmbed = ComponentBuilder.buildShoppingCart(productArray, cart.paymentMethod);
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [cartEmbed]
        });
    } catch (error) {
        console.error('❌ Erro ao voltar para produtos:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleRemoveItemSelect(interaction) {
    try {
        const value = interaction.values[0];
        const parts = value.split('_');
        const productId = parts.slice(1, -1).join('_'); // Reconstrói productId mesmo se tiver _
        const subIndex = parts[parts.length - 1]; // Último elemento é sempre o index
        const channelId = interaction.channel.id;
        
        CartManager.removeItem(channelId, productId, parseInt(subIndex));
        const cart = CartManager.getCart(channelId);
        
        // Mostrar carrinho atualizado
        const cartSummary = ComponentBuilder.buildCartSummary(cart);
        
        if (cartSummary) {
            await interaction.update({
                flags: ['IsComponentsV2'],
                components: cartSummary
            });
        } else {
            // Se carrinho ficou vazio, voltar para seleção de produtos
            const cartData = CartManager.getCart(channelId);
            if (cartData.paymentMethod) {
                const products = await Products.load();
                const productArray = Object.entries(products).map(([id, product]) => ({
                    id,
                    ...product
                }));
                
                const cartEmbed = ComponentBuilder.buildShoppingCart(productArray, cartData.paymentMethod);
                
                await interaction.update({
                    flags: ['IsComponentsV2'],
                    components: [cartEmbed]
                });
            } else {
                const cartEmbed = ComponentBuilder.buildShoppingCart();
                await interaction.update({
                    flags: ['IsComponentsV2'],
                    components: [cartEmbed]
                });
            }
        }
        
        console.log(`🗑️ Item removido do carrinho: ${productId}_${subIndex} (Canal: ${channelId})`);
        
    } catch (error) {
        console.error('❌ Erro ao remover item do carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleFinalizePurchase(interaction) {
    try {
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        if (cart.items.length === 0) {
            await Utils.safeReply(interaction, { content: '❌ Carrinho vazio! Adicione produtos antes de finalizar.', ephemeral: true });
            return;
        }
        
        // Construir texto dos itens para finalização
        let itemsText = "\n **Método de Pagamento:** ";
        itemsText += cart.paymentMethod ? Utils.getPaymentDisplay(cart.paymentMethod) : "*[Não selecionado]*";
        itemsText += "\n🛒 **Itens no Carrinho:**\n\n";

        cart.items.forEach((item, index) => {
            itemsText += ` **Produto:** ${item.productTitle} - ${item.subproductName}\n`;
            itemsText += ` **Valor Unitário:** R$ ${item.price.toFixed(2)} x ${item.quantity}\n`;
            itemsText += ` **Total:** R$ ${(item.price * item.quantity).toFixed(2)}\n\n`;
        });

        itemsText += `**Valor Final:** R$ ${cart.total.toFixed(2)}`;

        // Primeiro componente - Cabeçalho com botão do site
        const mainComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 5,
                        label: "Nosso Site",
                        emoji: null,
                        disabled: false,
                        url: "https://rootunk.xyz"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 🛒 **Finalizar Compra**"
                        }
                    ]
                },
                {
                    type: 10,
                    content: itemsText
                }
            ]
        };

        // Segundo componente - Botões de ação
        const buttonsComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 3,
                            label: "✅ Confirmar e Pagar",
                            emoji: null,
                            disabled: false,
                            custom_id: "confirm_payment"
                        },
                        {
                            type: 2,
                            style: 4,
                            label: "⬅️ Voltar ao Carrinho",
                            emoji: null,
                            disabled: false,
                            custom_id: "back_to_cart"
                        }
                    ]
                }
            ]
        };
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [mainComponent, buttonsComponent]
        });
        
    } catch (error) {
        console.error('❌ Erro ao finalizar compra:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleBackToProductList(interaction) {
    try {
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        // Carregar produtos disponíveis
        const products = await Products.load();
        const productArray = Object.entries(products).map(([id, product]) => ({
            id,
            ...product
        }));
        
        const cartEmbed = ComponentBuilder.buildShoppingCart(productArray, cart.paymentMethod);
        
        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [cartEmbed]
        });
    } catch (error) {
        console.error('❌ Erro ao voltar para lista de produtos:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleBackToCart(interaction) {
    try {
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        const cartSummary = ComponentBuilder.buildCartSummary(cart);
        
        if (cartSummary) {
            await interaction.update({
                flags: ['IsComponentsV2'],
                components: cartSummary
            });
        } else {
            // Se carrinho vazio, voltar para seleção de produtos
            if (cart.paymentMethod) {
                const products = await Products.load();
                const productArray = Object.entries(products).map(([id, product]) => ({
                    id,
                    ...product
                }));
                
                const cartEmbed = ComponentBuilder.buildShoppingCart(productArray, cart.paymentMethod);
                
                await interaction.update({
                    flags: ['IsComponentsV2'],
                    components: [cartEmbed]
                });
            } else {
                const cartEmbed = ComponentBuilder.buildShoppingCart();
                await interaction.update({
                    flags: ['IsComponentsV2'],
                    components: [cartEmbed]
                });
            }
        }
    } catch (error) {
        console.error('❌ Erro ao voltar ao carrinho:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function handleConfirmPayment(interaction) {
    try {
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        if (cart.items.length === 0) {
            await Utils.safeReply(interaction, { content: '❌ Carrinho vazio! Adicione produtos antes de finalizar.', ephemeral: true });
            return;
        }
        
        if (!cart.paymentMethod) {
            await Utils.safeReply(interaction, { content: '❌ Método de pagamento não selecionado!', ephemeral: true });
            return;
        }
        
        console.log(`🔍 Debug confirm payment - Itens no carrinho: ${cart.items.length}`);
        console.log(`🔍 Debug confirm payment - Items:`, cart.items.map(i => `${i.productId}[${i.subIndex}] x${i.quantity}`));
        
        // Verificar estoque de todos os itens primeiro
        for (const item of cart.items) {
            const stockAvailable = await StockSystem.getAvailableCount(item.productId, item.subIndex);
            if (stockAvailable < item.quantity) {
                await Utils.safeReply(interaction, { 
                    content: `❌ Estoque insuficiente para ${item.productTitle}. Disponível: ${stockAvailable}, Solicitado: ${item.quantity}`, 
                    ephemeral: true 
                });
                return;
            }
        }
        
        // Para qualquer quantidade de itens, usar a mesma lógica
        if (cart.paymentMethod === 'another_method') {
            // Se há múltiplos itens, usar o primeiro para o modal (depois será processado tudo junto)
            const firstItem = cart.items[0];
            const modal = new ModalBuilder()
                .setCustomId(`payment_method_modal_${firstItem.productId}_${firstItem.subIndex}`)
                .setTitle('Método de Pagamento');

            const methodInput = new TextInputBuilder()
                .setCustomId('method_input')
                .setLabel('Método Desejado')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ex: PayPal, Transferência...')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(methodInput));
            await interaction.showModal(modal);
            return;
        }
        
        // Processar compra (único ou múltiplos itens)
        if (cart.items.length === 1) {
            const item = cart.items[0];
            const products = await Products.load();
            const product = products[item.productId];
            const subproduct = product?.subprodutos[item.subIndex];
            
            if (!product || !subproduct) {
                await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
                return;
            }
            
            // Processar compra única
            await processSingleItemPurchase(interaction, cart, item, product, subproduct);
        } else {
            // Múltiplos itens - processar como compra múltipla
            await processMultipleItemsPurchase(interaction, cart);
        }
        
    } catch (error) {
        console.error('❌ Erro ao confirmar pagamento:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

async function processSingleItemPurchase(interaction, cart, item, product, subproduct) {
    try {
        // Lógica similar ao handleSubproductSelect para item único
        const globalDiscountActive = await GlobalDiscount.isActive();
        let finalPrice = subproduct.preco * item.quantity;
        
        if (globalDiscountActive) {
            const discountPercentage = await GlobalDiscount.getPercentage();
            finalPrice = finalPrice * (1 - discountPercentage);
        }

        const channelId = interaction.channel.id;
        const resellers = await Resellers.load();
        const hasResellers = Object.keys(resellers).length > 0;
        
        // Verificar se usuário tem saldo
        let displayPrice = `R$ ${finalPrice.toFixed(2)}`;
        let balanceToUse = 0;
        let remainingPrice = finalPrice;
        
        if (await BalanceSystem.hasBalance(interaction.user.id)) {
            const userBalance = await BalanceSystem.getBalance(interaction.user.id);
            if (userBalance > 0) {
                balanceToUse = Math.min(userBalance, finalPrice);
                remainingPrice = finalPrice - balanceToUse;
                if (remainingPrice <= 0) {
                    displayPrice = `Grátis (Saldo: R$ ${balanceToUse.toFixed(2)})`;
                } else {
                    displayPrice = `R$ ${remainingPrice.toFixed(2)} (Saldo: R$ ${balanceToUse.toFixed(2)})`;
                }
            }
        }

        // Interface de confirmação de pagamento para item único
        let itemsText = "\n **Método de Pagamento:** ";
        itemsText += Utils.getPaymentDisplay(cart.paymentMethod);
        itemsText += "\n🛒 **Item a Comprar:**\n\n";
        itemsText += ` **Produto:** ${product.titulo} - ${subproduct.nome}\n`;
        itemsText += ` **Quantidade:** ${item.quantity}\n`;
        itemsText += ` **Valor:** ${displayPrice}\n`;
        
        if (globalDiscountActive) {
            const discountPercentage = (await GlobalDiscount.getPercentage() * 100).toFixed(0);
            itemsText += `**Desconto:** ${discountPercentage}% aplicado!\n`;
        }
        
        if (balanceToUse > 0 && remainingPrice > 0) {
            itemsText += `\n💰 **Pagamento Misto:**\n`;
            itemsText += `• Saldo: R$ ${balanceToUse.toFixed(2)}\n`;
            itemsText += `• ${Utils.getPaymentDisplay(cart.paymentMethod)}: R$ ${remainingPrice.toFixed(2)}`;
        }

        const purchaseEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 5,
                        label: "Nosso Site",
                        emoji: null,
                        disabled: false,
                        url: "https://rootunk.store"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 💰 **Confirmar Pagamento**"
                        }
                    ]
                },
                {
                    type: 10,
                    content: itemsText
                }
            ]
        };

        const buttonsComponent = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 3,
                            label: "✅ Finalizar Compra",
                            emoji: null,
                            disabled: false,
                            custom_id: `complete_single_purchase_${item.productId}_${item.subIndex}`
                        },
                        {
                            type: 2,
                            style: 4,
                            label: "⬅️ Voltar ao Carrinho",
                            emoji: null,
                            disabled: false,
                            custom_id: "back_to_cart"
                        }
                    ]
                }
            ]
        };

        await interaction.update({
            flags: ['IsComponentsV2'],
            components: [purchaseEmbed, buttonsComponent]
        });
        
        // Carrinho será limpo apenas após a finalização bem-sucedida
        
    } catch (error) {
        console.error('❌ Erro ao processar compra única:', error);
        throw error;
    }
}

async function processMultipleItemsPurchase(interaction, cart) {
    try {
        // Para múltiplos itens, vou criar uma interface personalizada
        let totalPrice = cart.total;
        const globalDiscountActive = await GlobalDiscount.isActive();
        
        if (globalDiscountActive) {
            const discountPercentage = await GlobalDiscount.getPercentage();
            totalPrice = totalPrice * (1 - discountPercentage);
        }

        // Verificar saldo
        let displayPrice = `R$ ${totalPrice.toFixed(2)}`;
        let balanceToUse = 0;
        let remainingPrice = totalPrice;
        
        if (await BalanceSystem.hasBalance(interaction.user.id)) {
            const userBalance = await BalanceSystem.getBalance(interaction.user.id);
            if (userBalance > 0) {
                balanceToUse = Math.min(userBalance, totalPrice);
                remainingPrice = totalPrice - balanceToUse;
                if (remainingPrice <= 0) {
                    displayPrice = `Grátis (Saldo: R$ ${balanceToUse.toFixed(2)})`;
                } else {
                    displayPrice = `R$ ${remainingPrice.toFixed(2)} (Saldo: R$ ${balanceToUse.toFixed(2)})`;
                }
            }
        }

        // Construir resumo dos itens
        let itemsText = "\n **Método de Pagamento:** ";
        itemsText += Utils.getPaymentDisplay(cart.paymentMethod);
        itemsText += "\n🛒 **Itens Confirmados:**\n\n";

        cart.items.forEach((item, index) => {
            itemsText += ` **${index + 1}.** ${item.productTitle} - ${item.subproductName}\n`;
            itemsText += ` **Qtd:** ${item.quantity} x R$ ${item.price.toFixed(2)} = R$ ${(item.price * item.quantity).toFixed(2)}\n\n`;
        });

        itemsText += `💵 **TOTAL:** ${displayPrice}`;
        
        if (globalDiscountActive) {
            const discountPercentage = (await GlobalDiscount.getPercentage() * 100).toFixed(0);
            itemsText += `\n **Desconto Global:** ${discountPercentage}% aplicado!`;
        }

        const confirmationEmbed = {
            type: 17,
            accent_color: null,
            spoiler: false,
            components: [
                {
                    type: 9,
                    accessory: {
                        type: 2,
                        style: 5,
                        label: "Nosso Site",
                        emoji: null,
                        disabled: false,
                        url: "https://rootunk.store"
                    },
                    components: [
                        {
                            type: 10,
                            content: "# 💰 **Confirmar Pagamento**"
                        }
                    ]
                },
                {
                    type: 10,
                    content: itemsText
                }
            ]
        };

        // Verificar se há valor restante para pagar
        if (remainingPrice > 0) {
            // Criar PIX para valor restante
            if (cart.paymentMethod === 'pix' && efi && process.env.PIX_KEY) {
                try {
                    // Criar pagamento PIX
                    const description = `Carrinho com ${cart.items.length} itens - ${cart.items.map(item => `${item.productTitle} (${item.quantity}x)`).join(', ')}`;
                    const pixData = await PIX.createCharge(remainingPrice, description);
                    
                    // Criar pagamento personalizado para monitoramento
                    const payment = await CustomPaymentSystem.create(
                        interaction.user.id, 
                        interaction.user.tag, 
                        remainingPrice, 
                        description, 
                        interaction.channel.id
                    );
                    
                    // Atualizar pagamento com dados do EFI
                    const payments = await CustomPaymentSystem.load();
                    const paymentIndex = payments.findIndex(p => p.id === payment.id);
                    if (paymentIndex !== -1) {
                        payments[paymentIndex].efiTxid = pixData.txid;
                        payments[paymentIndex].pixCode = pixData.pixCopiaECola;
                        await CustomPaymentSystem.save(payments);
                        
                        payment.efiTxid = pixData.txid;
                        payment.pixCode = pixData.pixCopiaECola;
                    }
                    
                    // Gerar QR Code
                    const qrFileName = `cart_multiple_pix_${payment.id}_${Date.now()}.png`;
                    const qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
                    const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
                    
                    // Embed de pagamento PIX para múltiplos itens
                    const pixEmbed = {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 9,
                                accessory: {
                                    type: 2,
                                    style: 5,
                                    label: "Nosso Site",
                                    emoji: null,
                                    disabled: false,
                                    url: "https://rootunk.store"
                                },
                                components: [
                                    {
                                        type: 10,
                                        content: "# 💰 **Pagamento PIX - Múltiplos Itens**"
                                    }
                                ]
                            },
                            {
                                type: 10,
                                content: `**Pagamento Misto Confirmado!**\n\n🛒 **Itens no Carrinho:** ${cart.items.length}\n💰 **Saldo usado:** R$ ${balanceToUse.toFixed(2)}\n💳 **PIX a pagar:** R$ ${remainingPrice.toFixed(2)}\n\n**Escaneie o QR Code ou copie o código PIX abaixo:**`
                            }
                        ]
                    };
                    
                    const pixInstructionsEmbed = {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 12,
                                items: [{ media: { url: `attachment://${qrFileName}` } }]
                            },
                            {
                                type: 10,
                                content: `**Código PIX:**\n\`\`\`\n${pixData.pixCopiaECola}\n\`\`\`\n**⏰ Expira em:** <t:${Math.floor(payment.expiresAt / 1000)}:R>`
                            },
                            {
                                type: 1,
                                components: [
                                    {
                                        type: 2,
                                        style: 2,
                                        label: "Estamos Processando!",
                                        emoji: null,
                                        disabled: true,
                                        custom_id: "processing_payment"
                                    }
                                ]
                            }
                        ]
                    };
                    
                    await interaction.update({
                        flags: ['IsComponentsV2'],
                        components: [pixEmbed, pixInstructionsEmbed],
                        files: [qrAttachment]
                    });
                    
                    // Iniciar monitoramento do pagamento
                    PIX.monitorCustomPayment(payment, interaction.channel.id);
                    
                    // Armazenar dados da compra para finalização após pagamento
                    const purchaseData = {
                        type: 'multiple',
                        cart,
                        totalPrice,
                        balanceUsed: balanceToUse,
                        remainingPrice,
                        paymentId: payment.id,
                        channelId: interaction.channel.id
                    };
                    
                    // Armazenar dados para finalização após pagamento confirmado
                    global.pendingPurchases = global.pendingPurchases || new Map();
                    global.pendingPurchases.set(payment.id, purchaseData);
                    
                } catch (error) {
                    console.error('❌ Erro ao criar PIX para múltiplos itens:', error);
                    await Utils.safeReply(interaction, { 
                        content: `❌ Erro ao gerar PIX: ${error.message}`, 
                        ephemeral: true 
                    });
                }
            } else {
                await Utils.safeReply(interaction, { 
                    content: `💰 Valor restante a pagar: R$ ${remainingPrice.toFixed(2)}\n\nMétodo de pagamento ${cart.paymentMethod} não suportado ou PIX não configurado.`, 
                    ephemeral: true 
                });
            }
        } else {
            // Pagamento completo com saldo - mostrar confirmação
            await interaction.update({
                flags: ['IsComponentsV2'],
                components: [confirmationEmbed]
            });
        }
        
    } catch (error) {
        console.error('❌ Erro ao processar compra múltipla:', error);
        throw error;
    }
}

async function handleCompleteSinglePurchase(interaction) {
    try {
        console.log(`🔧 handleCompleteSinglePurchase - custom_id: ${interaction.customId}`);
        
        // Extrair productId e subIndex do custom_id
        const customIdParts = interaction.customId.split('_');
        console.log(`🔧 custom_id parts:`, customIdParts);
        
        const productId = customIdParts.slice(3, -1).join('_'); // Reconstrói productId
        const subIndex = parseInt(customIdParts[customIdParts.length - 1]);
        
        console.log(`🛒 Finalizando compra única: ${productId}[${subIndex}]`);
        
        const channelId = interaction.channel.id;
        const cart = CartManager.getCart(channelId);
        
        console.log(`🔍 Debug carrinho - Items:`, cart.items);
        console.log(`🔍 Debug busca - ProductID: ${productId}, SubIndex: ${subIndex}`);
        
        // Encontrar o item no carrinho - primeiro tentar busca exata
        let item = cart.items.find(i => {
            console.log(`🔍 Comparando: ${i.productId} === ${productId} && ${i.subIndex} === ${subIndex}`);
            return i.productId === productId && i.subIndex === subIndex;
        });
        
        // Se não encontrou com busca exata e há apenas um item, usar esse item
        if (!item && cart.items.length === 1) {
            console.log(`⚠️ Busca exata falhou, mas há apenas 1 item. Usando item único.`);
            item = cart.items[0];
        }
        
        // Se ainda não encontrou, tentar buscar por productId apenas
        if (!item) {
            item = cart.items.find(i => i.productId === productId);
            if (item) {
                console.log(`⚠️ Encontrado item com mesmo productId mas subIndex diferente. Usando item encontrado.`);
            }
        }
        
        if (!item) {
            console.log(`❌ Item não encontrado! Carrinho atual:`, JSON.stringify(cart.items, null, 2));
            await Utils.safeReply(interaction, { content: '❌ Item não encontrado no carrinho. Tente adicionar o produto novamente.', ephemeral: true });
            return;
        }
        
        console.log(`✅ Item encontrado: ${item.productTitle} - ${item.subproductName} (${item.productId}[${item.subIndex}])`);
        
        // Atualizar productId e subIndex com os valores reais do item encontrado
        const actualProductId = item.productId;
        const actualSubIndex = item.subIndex;
        
        const products = await Products.load();
        const product = products[actualProductId];
        const subproduct = product?.subprodutos[actualSubIndex];
        
        if (!product || !subproduct) {
            await Utils.safeReply(interaction, { content: '❌ Produto não encontrado.', ephemeral: true });
            return;
        }
        
        // Verificar estoque novamente
        const stockAvailable = await StockSystem.getAvailableCount(actualProductId, actualSubIndex);
        if (stockAvailable < item.quantity) {
            await Utils.safeReply(interaction, { 
                content: `❌ Estoque insuficiente. Disponível: ${stockAvailable}, Solicitado: ${item.quantity}`, 
                ephemeral: true 
            });
            return;
        }
        
        // Calcular preço final
        const globalDiscountActive = await GlobalDiscount.isActive();
        let finalPrice = subproduct.preco * item.quantity;
        
        if (globalDiscountActive) {
            const discountPercentage = await GlobalDiscount.getPercentage();
            finalPrice = finalPrice * (1 - discountPercentage);
        }
        
        // Verificar e usar saldo
        let balanceUsed = 0;
        let remainingPrice = finalPrice;
        
        if (await BalanceSystem.hasBalance(interaction.user.id)) {
            const userBalance = await BalanceSystem.getBalance(interaction.user.id);
            if (userBalance > 0) {
                balanceUsed = Math.min(userBalance, finalPrice);
                remainingPrice = finalPrice - balanceUsed;
                
                // Deduzir saldo usado
                if (balanceUsed > 0) {
                    await BalanceSystem.removeBalance(interaction.user.id, balanceUsed);
                }
            }
        }
        
        // Se não há valor restante para pagar, finalizar direto com saldo
        if (remainingPrice <= 0) {
            // Processar entrega
            const keys = await StockSystem.removeStock(actualProductId, actualSubIndex, item.quantity);
            
            if (!keys || keys.length === 0) {
                await Utils.safeReply(interaction, { content: '❌ Erro ao processar estoque.', ephemeral: true });
                return;
            }
            
            // Registrar transação
            const transaction = {
                id: Utils.generateTransactionId(),
                userId: interaction.user.id,
                userTag: interaction.user.tag,
                productId: actualProductId,
                productTitle: product.titulo,
                subproductName: subproduct.nome,
                quantity: item.quantity,
                originalPrice: subproduct.preco * item.quantity,
                finalPrice,
                discountApplied: globalDiscountActive,
                paymentMethod: 'saldo',
                balanceUsed,
                timestamp: new Date().toISOString(),
                keys,
                channelId
            };
            
            await TransactionSystem.save(transaction);
            
            // Atualizar estatísticas do produto
            const productsData = await Products.load();
            if (productsData[actualProductId]) {
                productsData[actualProductId].sales_count = (productsData[actualProductId].sales_count || 0) + item.quantity;
                productsData[actualProductId].total_revenue = (productsData[actualProductId].total_revenue || 0) + finalPrice;
                await Products.save(productsData);
            }
            
            // Embed de confirmação
            const successEmbed = {
                type: 17,
                accent_color: null,
                spoiler: false,
                components: [
                    {
                        type: 9,
                        accessory: {
                            type: 2,
                            style: 5,
                            label: "Nosso Site",
                            emoji: null,
                            disabled: false,
                            url: "https://rootunk.store"
                        },
                        components: [
                            {
                                type: 10,
                                content: "# ✅ **Compra Finalizada!**"
                            }
                        ]
                    },
                    {
                        type: 10,
                        content: `🎉 **Parabéns!** Sua compra foi processada com sucesso!\n\n **Produto:** ${product.titulo} - ${subproduct.nome}\n **Quantidade:** ${item.quantity}\n **Valor:** R$ ${finalPrice.toFixed(2)} (Pago com saldo)\n\n**🔑 Suas chaves:**\n\`\`\`\n${keys.join('\n')}\n\`\`\``
                    }
                ]
            };
            
            await interaction.update({
                flags: ['IsComponentsV2'],
                components: [successEmbed]
            });
            
            // Enviar chaves no privado do usuário
            try {
                const user = await client.users.fetch(interaction.user.id);
                const privateEmbed = {
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 9,
                            accessory: {
                                type: 2,
                                style: 5,
                                label: "Tutorial: ",
                                emoji: null,
                                disabled: false,
                                url: "http://rootunk.store/tutoriais."
                            },
                            components: [
                                {
                                    type: 10,
                                    content: "# 💰 Suas Chaves - Root@Unk"
                                }
                            ]
                        },
                        {
                            type: 9,
                            accessory: {
                                type: 2,
                                style: 5,
                                label: "Download",
                                emoji: null,
                                disabled: false,
                                url: "https://softwares.squareweb.app/"
                            },
                            components: [
                                {
                                    type: 10,
                                    content: `> 🎉 **Compra Finalizada!**\n> Suas chaves foram entregues com sucesso.\n\n📦 **Produto:** ${product.titulo} — ${subproduct.nome}\n💰 **Valor Total:** R$ ${finalPrice.toFixed(2)}\n💳 **Forma de Pagamento:** Saldo`
                                }
                            ]
                        }
                    ]
                };

                const privateEmbedSecond = {
                    type: 17,
                    accent_color: null,
                    spoiler: false,
                    components: [
                        {
                            type: 10,
                            content: `🔑 **Key:**\n\`\`\`\n${keys.join('\n')}\n\`\`\``
                        }
                    ]
                };

                const privateEmbedThird = {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 2,
                            label: "Valor:",
                            emoji: null,
                            disabled: false,
                            custom_id: "f792b207a70547b8dfa1b3737d822826"
                        },
                        {
                            type: 2,
                            style: 2,
                            label: "Data:",
                            emoji: null,
                            disabled: false,
                            custom_id: "a6c402fd41dc47e4a4b216b70162a776"
                        }
                    ]
                };
                
                await user.send({
                    flags: ['IsComponentsV2'],
                    components: [privateEmbed, privateEmbedSecond, privateEmbedThird]
                });
                
                console.log(`📬 Chaves enviadas no privado para ${interaction.user.tag}`);
            } catch (privateError) {
                console.error('❌ Erro enviando chaves no privado:', privateError);
            }
            
            // Limpar carrinho e agendar deleção do canal
            CartManager.clearCart(channelId);
            
            setTimeout(async () => {
                try {
                    if (interaction.channel && !interaction.channel.deleted) {
                        await interaction.channel.delete('Compra finalizada com saldo');
                    }
                } catch (error) {
                    console.error('Erro fechando canal:', error);
                }
            }, 30000);
            
        } else {
            // Ainda há valor a pagar - criar PIX
            console.log(`💰 Valor restante para ${actualProductId}[${actualSubIndex}]: R$ ${remainingPrice.toFixed(2)}`);
            
            if (cart.paymentMethod === 'pix' && efi && process.env.PIX_KEY) {
                try {
                    // Criar pagamento PIX
                    const description = `${product.titulo} - ${subproduct.nome} (Qtd: ${item.quantity})`;
                    const pixData = await PIX.createCharge(remainingPrice, description);
                    
                    // Criar pagamento personalizado para monitoramento
                    const payment = await CustomPaymentSystem.create(
                        interaction.user.id, 
                        interaction.user.tag, 
                        remainingPrice, 
                        description, 
                        channelId
                    );
                    
                    // Atualizar pagamento com dados do EFI
                    const payments = await CustomPaymentSystem.load();
                    const paymentIndex = payments.findIndex(p => p.id === payment.id);
                    if (paymentIndex !== -1) {
                        payments[paymentIndex].efiTxid = pixData.txid;
                        payments[paymentIndex].pixCode = pixData.pixCopiaECola;
                        await CustomPaymentSystem.save(payments);
                        
                        payment.efiTxid = pixData.txid;
                        payment.pixCode = pixData.pixCopiaECola;
                    }
                    
                    // Gerar QR Code
                    const qrFileName = `cart_pix_${payment.id}_${Date.now()}.png`;
                    const qrFilePath = await PIX.generateQRCode(pixData.pixCopiaECola, qrFileName);
                    const qrAttachment = new AttachmentBuilder(qrFilePath, { name: qrFileName });
                    
                    // Embed de pagamento PIX
                    const pixEmbed = {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 9,
                                accessory: {
                                    type: 2,
                                    style: 5,
                                    label: "Nosso Site",
                                    emoji: null,
                                    disabled: false,
                                    url: "https://rootunk.store"
                                },
                                components: [
                                    {
                                        type: 10,
                                        content: "# 💰 **Pagamento PIX**"
                                    }
                                ]
                            },
                            {
                                type: 10,
                                content: `**Pagamento Misto Confirmado!**\n\n<:vendendo:1380665117473247356> **Produto:** ${product.titulo} - ${subproduct.nome}\n<:moedas:1380666331627786501> **Quantidade:** ${item.quantity}\n💰 **Saldo usado:** R$ ${balanceUsed.toFixed(2)}\n💳 **PIX a pagar:** R$ ${remainingPrice.toFixed(2)}\n\n**Escaneie o QR Code ou copie o código PIX abaixo:**`
                            }
                        ]
                    };
                    
                    const pixInstructionsEmbed = {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 12,
                                items: [{ media: { url: `attachment://${qrFileName}` } }]
                            },
                            {
                                type: 10,
                                content: `**Código PIX:**\n\`\`\`\n${pixData.pixCopiaECola}\n\`\`\`\n**⏰ Expira em:** <t:${Math.floor(payment.expiresAt / 1000)}:R>`
                            },
                            {
                                type: 1,
                                components: [
                                    {
                                        type: 2,
                                        style: 2,
                                        label: "Estamos Processando!",
                                        emoji: null,
                                        disabled: true,
                                        custom_id: "processing_payment"
                                    }
                                ]
                            }
                        ]
                    };
                    
                    await interaction.update({
                        flags: ['IsComponentsV2'],
                        components: [pixEmbed, pixInstructionsEmbed],
                        files: [qrAttachment]
                    });
                    
                    // Iniciar monitoramento do pagamento
                    PIX.monitorCustomPayment(payment, channelId);
                    
                    // Armazenar dados da compra para finalização após pagamento
                    const purchaseData = {
                        productId: actualProductId,
                        subIndex: actualSubIndex,
                        product,
                        subproduct,
                        item,
                        finalPrice,
                        balanceUsed,
                        remainingPrice,
                        paymentId: payment.id,
                        channelId
                    };
                    
                    // Armazenar dados para finalização após pagamento confirmado
                    global.pendingPurchases = global.pendingPurchases || new Map();
                    global.pendingPurchases.set(payment.id, purchaseData);
                    
                } catch (error) {
                    console.error('❌ Erro ao criar PIX:', error);
                    await Utils.safeReply(interaction, { 
                        content: `❌ Erro ao gerar PIX: ${error.message}`, 
                        ephemeral: true 
                    });
                }
            } else {
                await Utils.safeReply(interaction, { 
                    content: `💰 Valor restante a pagar: R$ ${remainingPrice.toFixed(2)}\n\nMétodo de pagamento ${cart.paymentMethod} não suportado ou PIX não configurado.`, 
                    ephemeral: true 
                });
            }
        }
        
    } catch (error) {
        console.error('❌ Erro ao completar compra única:', error);
        await Utils.safeReply(interaction, { content: '❌ Erro interno.', ephemeral: true });
    }
}

// ===== HANDLERS PARA BOTÕES VALOR E DATA =====
async function handleValorButton(interaction) {
    try {
        // Extrair informações da mensagem para mostrar o valor
        const messageContent = interaction.message.content || '';
        const embedContent = interaction.message.components?.[0]?.components?.[0]?.components?.[1]?.content || '';
        
        // Procurar pelo valor na embed
        const valorMatch = embedContent.match(/💰 \*\*Valor:\*\* R\$ ([\d,]+\.?\d*)/);
        const valor = valorMatch ? valorMatch[1] : 'N/A';
        
        await Utils.safeReply(interaction, {
            content: `💰 **Valor Pago:** R$ ${valor}`,
            ephemeral: true
        });
        
    } catch (error) {
        console.error('❌ Erro ao processar botão Valor:', error);
        await Utils.safeReply(interaction, {
            content: '❌ Erro ao obter valor da transação.',
            ephemeral: true
        });
    }
}

async function handleDataButton(interaction) {
    try {
        // Obter a data atual da transação
        const now = new Date();
        const dataFormatada = now.toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        await Utils.safeReply(interaction, {
            content: `📅 **Data da Compra:** ${dataFormatada}`,
            ephemeral: true
        });
        
    } catch (error) {
        console.error('❌ Erro ao processar botão Data:', error);
        await Utils.safeReply(interaction, {
            content: '❌ Erro ao obter data da transação.',
            ephemeral: true
        });
    }
}

// ===== STARTUP =====
async function startBot() {
    try {
        const required = ['DISCORD_TOKEN'];
        const missing = required.filter(key => !process.env[key]);
        
        if (missing.length > 0) {
            console.error(`❌ Variáveis obrigatórias: ${missing.join(', ')}`);
            process.exit(1);
        }
        
        await Utils.ensureDataDir();
        console.log('🚀 Iniciando Root@Unk Bot...');
        await client.login(process.env.DISCORD_TOKEN);
        
    } catch (error) {
        console.error('❌ Erro fatal:', error);
        process.exit(1);
    }
}

startBot();

